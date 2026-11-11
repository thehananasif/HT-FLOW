import {
  OrderBook,
  type BarSpec,
  type BookSnapshot,
  type DepthColumn,
  type EventBatch,
  type HistoryData,
  type Level,
  type Trade,
} from '@htflow/market-data';
import { BarCursor } from './barCursor';
import { upperBoundTrades, type ReplayDataset } from './dataset';

/** Speed presets of the control bar (keys 1–7). */
export const REPLAY_SPEEDS = [0.25, 1, 5, 10, 50, 100, 1000] as const;

export interface ReplayEngineOptions {
  /**
   * Replay-time length of one emitted batch. Batches never span two cells of this grid, so a store
   * that samples depth per batch (MarketStore: every 250 ms) keeps full heatmap resolution even at
   * 1000×. Default 250.
   */
  batchMs?: number;
  /** Max wall-clock ms consumed by one scheduler tick (bounds catch-up after a stall). Default 100. */
  maxTickMs?: number;
  /** Interval of internal book keyframes used for fast seeking. Default 60 s. */
  keyframeMs?: number;
  /** Depth history rebuilt on seek: sampling interval, column count, levels per side. */
  depthIntervalMs?: number;
  maxDepthColumns?: number;
  depthLevels?: number;
}

export interface ReplayBookmark {
  id: string;
  t: number;
  label: string;
}

interface Keyframe {
  /** State after every book event with ts <= t. */
  t: number;
  di: number;
  si: number;
  nb: number;
  px: Int32Array;
  qty: Float64Array;
}

type BatchListener = (b: EventBatch) => void;

/**
 * Replays a recorded dataset as EventBatches stamped with replay time (P24 / P35).
 *
 * - The clock advances by wall time × speed; at high speed one tick covers many seconds, which are
 *   cut into `batchMs` batches — events are coalesced, never dropped.
 * - Every event is emitted exactly once and in order (book snapshots, then deltas, then trades at
 *   equal timestamps), so a MarketStore fed by the engine is identical to one fed live.
 * - Seeking (jump to time, step back bar, loop) rebuilds the full state: trades, book and depth
 *   history up to the target time; listeners receive `onReset` and read `state()`.
 */
export class ReplayEngine {
  readonly start: number;
  readonly end: number;
  /** Replay clock (epoch ms). Consumers only ever see events at or before it. */
  time: number;
  playing = false;
  speed = 1;
  loop: { from: number; to: number } | null = null;
  bookmarks: ReplayBookmark[] = [];
  /** Bumped on every state change (clock, controls, bookmarks). */
  version = 0;
  private ti = 0;
  private di = 0;
  private si = 0;
  private realBook = false;
  private synthBid = Number.NaN;
  private keyframes: Keyframe[] = [];
  private batchListeners = new Set<BatchListener>();
  private resetListeners = new Set<(t: number) => void>();
  private changeListeners = new Set<() => void>();
  private readonly opts: Required<ReplayEngineOptions>;
  private bmSeq = 0;

  constructor(
    readonly dataset: ReplayDataset,
    options: ReplayEngineOptions = {},
  ) {
    this.opts = {
      batchMs: options.batchMs ?? 250,
      maxTickMs: options.maxTickMs ?? 100,
      keyframeMs: options.keyframeMs ?? 60_000,
      depthIntervalMs: options.depthIntervalMs ?? 250,
      maxDepthColumns: options.maxDepthColumns ?? 7200,
      depthLevels: options.depthLevels ?? 150,
    };
    this.start = dataset.start;
    this.end = Math.max(dataset.start, dataset.end);
    this.time = this.start;
    this.buildKeyframes();
    this.position(this.start);
  }

  get instrument() {
    return this.dataset.instrument;
  }

  /** Index of the next trade to be emitted (= number of trades already replayed). */
  get tradeIndex(): number {
    return this.ti;
  }

  get atEnd(): boolean {
    return this.time >= this.end && this.ti >= this.dataset.trades.length;
  }

  // ------------------------------------------------------------------ listeners

  subscribe(fn: BatchListener): () => void {
    this.batchListeners.add(fn);
    return () => this.batchListeners.delete(fn);
  }

  /** Called after a seek; read the rebuilt state with `state()`. */
  onReset(fn: (time: number) => void): () => void {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private changed(): void {
    this.version++;
    for (const l of this.changeListeners) l();
  }

  // ------------------------------------------------------------------ controls

  play(): void {
    if (this.atEnd) this.seek(this.loop?.from ?? this.start);
    if (this.playing) return;
    this.playing = true;
    this.changed();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.changed();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(x: number): void {
    if (!(x > 0) || !Number.isFinite(x)) throw new Error(`Invalid replay speed ${x}`);
    this.speed = x;
    this.changed();
  }

  /** Loops [from, to] while playing; null clears. */
  setLoop(range: { from: number; to: number } | null): void {
    if (range) {
      const from = this.clamp(Math.min(range.from, range.to));
      const to = this.clamp(Math.max(range.from, range.to));
      this.loop = to > from ? { from, to } : null;
    } else this.loop = null;
    this.changed();
  }

  addBookmark(t = this.time, label?: string): ReplayBookmark {
    const b: ReplayBookmark = {
      id: `bm${++this.bmSeq}`,
      t: this.clamp(t),
      label: label ?? `Bookmark ${this.bmSeq}`,
    };
    this.bookmarks = [...this.bookmarks, b].sort((a, c) => a.t - c.t);
    this.changed();
    return b;
  }

  removeBookmark(id: string): void {
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    this.changed();
  }

  setBookmarks(list: ReplayBookmark[]): void {
    this.bookmarks = list.map((b) => ({ ...b, t: this.clamp(b.t) })).sort((a, c) => a.t - c.t);
    this.bmSeq = Math.max(this.bmSeq, list.length);
    this.changed();
  }

  /** Scheduler entry point: advances by wall time × speed while playing. */
  tick(wallDtMs: number): EventBatch[] {
    if (!this.playing) return [];
    const dt = Math.min(Math.max(0, wallDtMs), this.opts.maxTickMs) * this.speed;
    const target = this.time + dt;
    if (this.loop && this.time < this.loop.to && target >= this.loop.to) {
      const out = this.advanceTo(this.loop.to);
      this.seek(this.loop.from);
      return out;
    }
    if (target >= this.end) {
      const out = this.advanceTo(this.end);
      this.playing = false;
      this.changed();
      return out;
    }
    return this.advanceTo(target);
  }

  /** Moves the clock forward to `t`, emitting every event up to it (at most `maxTrades` trades). */
  advanceTo(t: number, maxTrades = Infinity): EventBatch[] {
    const T = this.clamp(t);
    if (T < this.time) {
      this.seek(T);
      return [];
    }
    const out = this.emitTo(T, maxTrades);
    this.time = T;
    for (const b of out) for (const l of this.batchListeners) l(b);
    this.changed();
    return out;
  }

  /** Emits exactly one trade (plus the book events before it). */
  stepTick(): EventBatch[] {
    const tr = this.dataset.trades[this.ti];
    if (!tr) return this.advanceTo(this.end);
    return this.advanceTo(Math.max(this.time, tr.ts), 1);
  }

  /** Completes the current bar of `spec`, or forms the whole next bar if the current one is complete. */
  stepBar(spec: BarSpec): EventBatch[] {
    const trades = this.dataset.trades;
    const cur = new BarCursor(spec).addAll(trades, 0, this.ti);
    let j = this.ti;
    let n = 0;
    while (j < trades.length) {
      const tr = trades[j]!;
      if (n > 0 && cur.opensNewBar(tr)) break;
      cur.add(tr);
      j++;
      n++;
    }
    if (n === 0) return this.advanceTo(this.end);
    return this.advanceTo(Math.max(this.time, trades[j - 1]!.ts), n);
  }

  /** Removes the last bar of `spec` (re-seeks to just before its first trade). */
  stepBackBar(spec: BarSpec): void {
    if (this.ti === 0) {
      this.seek(this.start);
      return;
    }
    const cur = new BarCursor(spec).addAll(this.dataset.trades, 0, this.ti);
    this.seekToTrade(Math.max(0, cur.barStart));
  }

  /** Jump to time: rebuilds book, trades, bars and depth history at `t`. */
  seek(t: number): void {
    this.position(this.clamp(t));
    for (const l of this.resetListeners) l(this.time);
    this.changed();
  }

  /** Seeks to the moment just before trade `k` (trades [0, k) replayed). */
  seekToTrade(k: number): void {
    const trades = this.dataset.trades;
    const idx = Math.max(0, Math.min(trades.length, k));
    const t = idx > 0 ? trades[idx - 1]!.ts : this.start;
    this.position(this.clamp(t));
    this.ti = Math.min(this.ti, idx);
    for (const l of this.resetListeners) l(this.time);
    this.changed();
  }

  // ------------------------------------------------------------------ state

  /** Full state at the current position (what a store fed by this engine holds). */
  state(): HistoryData {
    const book = this.bookAt(this.time, this.ti);
    return {
      trades: this.dataset.trades.slice(0, this.ti),
      depth: this.depthHistory(this.time),
      book: book.snapshot(this.time),
      end: this.time,
    };
  }

  /** State at time t (all events with ts <= t), independent of the current position. */
  stateAt(t: number): HistoryData {
    const T = this.clamp(t);
    const n = upperBoundTrades(this.dataset.trades, T);
    return {
      trades: this.dataset.trades.slice(0, n),
      depth: this.depthHistory(T),
      book: this.bookAt(T, n).snapshot(T),
      end: T,
    };
  }

  /** Order book at time t. `tradeCount` is used for the trade-derived book when no depth exists. */
  bookAt(t: number, tradeCount = upperBoundTrades(this.dataset.trades, t)): OrderBook {
    const ob = this.realBookAt(t);
    if (ob) return ob;
    const out = new OrderBook();
    const last = this.dataset.trades[tradeCount - 1];
    if (last) out.applySnapshot(this.synthetic(last, t));
    return out;
  }

  private clamp(t: number): number {
    return Math.min(this.end, Math.max(this.start, t));
  }

  private position(T: number): void {
    const d = this.dataset;
    this.time = T;
    this.ti = upperBoundTrades(d.trades, T);
    this.di = d.deltas.upperBound(T);
    this.si = upperBoundSnapshots(d.snapshots, T);
    this.realBook = !!d.initialBook || this.di > 0 || this.si > 0;
    this.synthBid = Number.NaN;
  }

  private synthetic(tr: Trade, ts: number): BookSnapshot {
    const bid = tr.side === 'buy' ? tr.px - 1 : tr.px;
    return { ts, bids: [[bid, 1]], asks: [[bid + 1, 1]] };
  }

  /** Book reconstructed from keyframes / snapshots / deltas, or null when no depth is known. */
  private realBookAt(T: number): OrderBook | null {
    const d = this.dataset;
    const D = d.deltas;
    const S = d.snapshots;
    const ob = new OrderBook();
    let have = false;
    let di = 0;
    let si = 0;
    const kf = this.keyframeAt(T);
    if (kf) {
      const bids: Level[] = [];
      const asks: Level[] = [];
      for (let i = 0; i < kf.px.length; i++)
        (i < kf.nb ? bids : asks).push([kf.px[i]!, kf.qty[i]!]);
      ob.applySnapshot({ ts: kf.t, bids, asks });
      di = kf.di;
      si = kf.si;
      have = true;
    } else if (d.initialBook) {
      ob.applySnapshot(d.initialBook);
      have = true;
    }
    const sLast = upperBoundSnapshots(S, T) - 1;
    if (sLast >= si) {
      ob.applySnapshot(S[sLast]!);
      di = Math.max(di, lowerBoundDeltas(D.ts, D.length, S[sLast]!.ts));
      have = true;
    }
    const dEnd = D.upperBound(T);
    if (dEnd > di) have = true;
    for (; di < dEnd; di++) ob.applyDelta(D.get(di));
    return have ? ob : null;
  }

  private keyframeAt(T: number): Keyframe | undefined {
    const k = this.keyframes;
    let lo = 0;
    let hi = k.length - 1;
    if (hi < 0 || k[0]!.t > T) return undefined;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (k[mid]!.t <= T) lo = mid;
      else hi = mid - 1;
    }
    return k[lo];
  }

  private buildKeyframes(): void {
    const d = this.dataset;
    const D = d.deltas;
    if (D.length === 0) return;
    const S = d.snapshots;
    const ob = new OrderBook();
    if (d.initialBook) ob.applySnapshot(d.initialBook);
    const step = this.opts.keyframeMs;
    const record = (t: number, di: number, si: number) => {
      const bids = [...ob.bids.entries()];
      const asks = [...ob.asks.entries()];
      const n = bids.length + asks.length;
      const px = new Int32Array(n);
      const qty = new Float64Array(n);
      let i = 0;
      for (const [p, q] of bids) {
        px[i] = p;
        qty[i++] = q;
      }
      for (const [p, q] of asks) {
        px[i] = p;
        qty[i++] = q;
      }
      this.keyframes.push({ t, di, si, nb: bids.length, px, qty });
    };
    if (d.initialBook) record(this.start, 0, 0);
    let next = this.start + step;
    let di = 0;
    let si = 0;
    while (di < D.length || si < S.length) {
      const tS = si < S.length ? S[si]!.ts : Infinity;
      const tD = di < D.length ? D.ts[di]! : Infinity;
      const ts = Math.min(tS, tD);
      if (ts > next) {
        record(next, di, si);
        next = this.start + (Math.floor((ts - this.start) / step) + 1) * step;
      }
      if (tS <= tD) ob.applySnapshot(S[si++]!);
      else ob.applyDelta(D.get(di++));
    }
  }

  /** Depth columns as MarketStore would have sampled them during the last `maxDepthColumns` intervals. */
  private depthHistory(T: number): DepthColumn[] {
    const d = this.dataset;
    if (!d.initialBook && d.deltas.length === 0 && d.snapshots.length === 0) return [];
    const iv = this.opts.depthIntervalMs;
    const first = Math.max(
      Math.ceil(this.start / iv) * iv,
      (Math.floor(T / iv) - this.opts.maxDepthColumns + 1) * iv,
    );
    if (first > T) return [];
    const ob = this.realBookAt(first);
    if (!ob) {
      // Book starts later (snapshots / deltas only); begin at the first book event.
      const t0 = Math.min(
        d.snapshots[0]?.ts ?? Infinity,
        d.deltas.length ? d.deltas.ts[0]! : Infinity,
      );
      if (!(t0 <= T)) return [];
      return this.depthFrom(Math.ceil(t0 / iv) * iv, T);
    }
    return this.depthFrom(first, T, ob);
  }

  private depthFrom(first: number, T: number, initial?: OrderBook): DepthColumn[] {
    const d = this.dataset;
    const D = d.deltas;
    const S = d.snapshots;
    const iv = this.opts.depthIntervalMs;
    const ob = initial ?? this.realBookAt(first) ?? new OrderBook();
    let di = D.upperBound(first);
    let si = upperBoundSnapshots(S, first);
    const out: DepthColumn[] = [];
    for (let g = first; g <= T; g += iv) {
      for (;;) {
        const tS = si < S.length ? S[si]!.ts : Infinity;
        const tD = di < D.length ? D.ts[di]! : Infinity;
        if (Math.min(tS, tD) > g) break;
        if (tS <= tD) ob.applySnapshot(S[si++]!);
        else ob.applyDelta(D.get(di++));
      }
      if (!Number.isNaN(ob.bestBid)) out.push(sampleDepth(ob, g, this.opts.depthLevels));
    }
    return out;
  }

  // ------------------------------------------------------------------ emission

  private emitTo(T: number, maxTrades: number): EventBatch[] {
    const d = this.dataset;
    const trades = d.trades;
    const D = d.deltas;
    const S = d.snapshots;
    const bm = this.opts.batchMs;
    const out: EventBatch[] = [];
    let cur: EventBatch | null = null;
    let cell = 0;
    let curHasBook = false;
    let emitted = 0;
    const flush = (ts: number) => {
      if (!cur) return;
      cur.ts = ts;
      this.finish(cur);
      out.push(cur);
      cur = null;
      curHasBook = false;
    };
    for (;;) {
      const tT = this.ti < trades.length ? trades[this.ti]!.ts : Infinity;
      const tD = this.di < D.length ? D.ts[this.di]! : Infinity;
      const tS = this.si < S.length ? S[this.si]!.ts : Infinity;
      let kind: 's' | 'd' | 't';
      let t: number;
      if (tS <= tD && tS <= tT) {
        kind = 's';
        t = tS;
      } else if (tD <= tT) {
        kind = 'd';
        t = tD;
      } else {
        kind = 't';
        t = tT;
      }
      if (!(t <= T)) break;
      if (kind === 't' && emitted >= maxTrades) break;
      const c = Math.floor(t / bm);
      if (cur && c !== cell) flush(Math.min(T, (cell + 1) * bm));
      // A snapshot replaces the book: never put it after book events of the same batch.
      if (kind === 's' && cur && curHasBook) flush(t);
      if (!cur) {
        cur = { ts: t, trades: [], deltas: [] };
        cell = c;
      }
      const b: EventBatch = cur;
      if (kind === 's') {
        b.snapshot = S[this.si++]!;
        curHasBook = true;
        this.realBook = true;
      } else if (kind === 'd') {
        b.deltas.push(D.get(this.di++));
        curHasBook = true;
        this.realBook = true;
      } else {
        b.trades.push(trades[this.ti++]!);
        emitted++;
      }
    }
    flush(T);
    return out;
  }

  /** Without recorded depth, keep a one-level book at the last trade so DOM and paper fills work. */
  private finish(b: EventBatch): void {
    if (this.realBook || b.snapshot || !b.trades.length) return;
    const s = this.synthetic(b.trades[b.trades.length - 1]!, b.ts);
    const bid = s.bids[0]![0];
    if (bid === this.synthBid) return;
    this.synthBid = bid;
    b.snapshot = s;
  }
}

function upperBoundSnapshots(s: readonly BookSnapshot[], t: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundDeltas(ts: Float64Array, n: number, t: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Same sampling rule as MarketStore (levels within `levels` ticks of the touch). */
export function sampleDepth(book: OrderBook, t: number, levels = 150): DepthColumn {
  const bb = book.bestBid;
  const ba = book.bestAsk;
  const pxs: number[] = [];
  const qs: number[] = [];
  for (const [px, q] of book.bids) {
    if (px > bb - levels) {
      pxs.push(px);
      qs.push(q);
    }
  }
  for (const [px, q] of book.asks) {
    if (px < ba + levels) {
      pxs.push(px);
      qs.push(q);
    }
  }
  return { t, bestBid: bb, bestAsk: ba, pxs: Int32Array.from(pxs), qtys: Float32Array.from(qs) };
}
