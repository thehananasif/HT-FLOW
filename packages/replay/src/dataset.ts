import {
  findMockInstrument,
  MarketSimulator,
  type BookDelta,
  type BookSnapshot,
  type DepthColumn,
  type Instrument,
  type Level,
  type Trade,
} from '@htflow/market-data';

/**
 * Columnar book deltas (~21 bytes per event instead of a ~60 byte object), so a full simulated
 * session of depth changes fits in memory. Times are epoch ms, prices integer ticks.
 */
export class DeltaLog {
  ts: Float64Array;
  px: Int32Array;
  qty: Float64Array;
  /** 0 = bid ('buy'), 1 = ask ('sell'). */
  side: Uint8Array;
  length = 0;

  constructor(capacity = 1024) {
    this.ts = new Float64Array(capacity);
    this.px = new Int32Array(capacity);
    this.qty = new Float64Array(capacity);
    this.side = new Uint8Array(capacity);
  }

  push(ts: number, d: BookDelta): void {
    if (this.length === this.ts.length) this.grow(this.length * 2);
    const i = this.length++;
    this.ts[i] = ts;
    this.px[i] = d.px;
    this.qty[i] = d.qty;
    this.side[i] = d.side === 'buy' ? 0 : 1;
  }

  get(i: number): BookDelta {
    return { side: this.side[i] === 0 ? 'buy' : 'sell', px: this.px[i]!, qty: this.qty[i]! };
  }

  /** Releases unused capacity once recording is done. */
  trim(): this {
    if (this.ts.length !== this.length) this.grow(this.length);
    return this;
  }

  bytes(): number {
    return this.length * 21;
  }

  /** First index with ts > t. */
  upperBound(t: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private grow(cap: number): void {
    const n = Math.max(1, cap);
    const ts = new Float64Array(n);
    const px = new Int32Array(n);
    const qty = new Float64Array(n);
    const side = new Uint8Array(n);
    ts.set(this.ts.subarray(0, this.length));
    px.set(this.px.subarray(0, this.length));
    qty.set(this.qty.subarray(0, this.length));
    side.set(this.side.subarray(0, this.length));
    this.ts = ts;
    this.px = px;
    this.qty = qty;
    this.side = side;
  }
}

/**
 * A recorded slice of market data: everything the replay engine needs to rebuild the book, the
 * tape, the depth history and every bar type at any moment in [start, end].
 *
 * Book events (snapshots and deltas) always have ts > start; the state at `start` itself is
 * `initialBook`. When no book information exists the engine derives a one-level book from trades.
 */
export interface ReplayDataset {
  /** The recorded instrument (the source, not the `replay:` alias). */
  instrument: Instrument;
  start: number;
  end: number;
  /** Trades in time order. */
  trades: Trade[];
  /** Full book replacements in time order (e.g. sampled depth columns). */
  snapshots: BookSnapshot[];
  /** Incremental book changes in time order. */
  deltas: DeltaLog;
  /** Book at `start`, when known. */
  initialBook?: BookSnapshot;
}

/** Which recorded layers to replay (P35 setup "data layers"). */
export interface ReplayLayers {
  ticks: boolean;
  /** Depth of market (heatmap + DOM). When off the book is derived from trades (one level). */
  depth: boolean;
}

export const DEFAULT_LAYERS: ReplayLayers = { ticks: true, depth: true };

/** Where data comes from and how large it is (setup "data on disk / in memory" line). */
export interface ReplayDataInfo {
  where: 'disk' | 'memory' | 'generated';
  /** Approximate size of the selected range in bytes. */
  bytes: number;
  /** Days of data available for the instrument. */
  days: number;
  trades: number;
  note?: string;
}

/**
 * A provider of recorded data. Implemented by the simulator (generated, deterministic by seed),
 * by in-memory MarketStore history, and later by the Rust tick store (P06) through IPC — register
 * another implementation with the same interface and the engine needs no change.
 */
export interface ReplayDataSource {
  readonly id: string;
  readonly label: string;
  /** True when this source can provide data for the instrument. */
  covers(instrumentId: string): boolean;
  /** Available time range, or null when there is no data. */
  range(instrumentId: string): Promise<{ from: number; to: number } | null>;
  info(instrumentId: string, from: number, to: number): Promise<ReplayDataInfo>;
  load(
    instrumentId: string,
    from: number,
    to: number,
    layers?: ReplayLayers,
  ): Promise<ReplayDataset>;
}

export function datasetBytes(d: ReplayDataset): number {
  let levels = 0;
  for (const s of d.snapshots) levels += s.bids.length + s.asks.length;
  return d.trades.length * 48 + d.deltas.bytes() + levels * 24;
}

/** Depth column (sampled resting liquidity) → full book snapshot. */
export function columnToSnapshot(c: DepthColumn): BookSnapshot {
  const bids: Level[] = [];
  const asks: Level[] = [];
  for (let i = 0; i < c.pxs.length; i++) {
    const px = c.pxs[i]!;
    const q = c.qtys[i]!;
    if (!(q > 0)) continue;
    if (px <= c.bestBid) bids.push([px, q]);
    else asks.push([px, q]);
  }
  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);
  return { ts: c.t, bids, asks };
}

function lowerBoundTrades(trades: readonly Trade[], t: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First trade index with ts > t. */
export function upperBoundTrades(trades: readonly Trade[], t: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid]!.ts <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Recorded history as a MarketStore keeps it in memory (trades + 250 ms depth columns). */
export interface RecordedHistory {
  instrument: Instrument;
  trades: readonly Trade[];
  depth: readonly DepthColumn[];
}

/**
 * Builds a dataset from in-memory history (any instrument, live or simulated). The book at
 * `from` is the last depth column at or before it; later columns become snapshot events.
 */
export function datasetFromHistory(
  h: RecordedHistory,
  from: number,
  to: number,
  layers: ReplayLayers = DEFAULT_LAYERS,
): ReplayDataset {
  const trades = layers.ticks
    ? h.trades.slice(lowerBoundTrades(h.trades, from), upperBoundTrades(h.trades, to))
    : [];
  const snapshots: BookSnapshot[] = [];
  let initialBook: BookSnapshot | undefined;
  if (layers.depth) {
    for (const c of h.depth) {
      if (c.t <= from) initialBook = columnToSnapshot(c);
      else if (c.t <= to) snapshots.push(columnToSnapshot(c));
      else break;
    }
    if (initialBook) initialBook = { ...initialBook, ts: from };
  }
  return {
    instrument: h.instrument,
    start: from,
    end: to,
    trades,
    snapshots,
    deltas: new DeltaLog(1).trim(),
    initialBook,
  };
}

export interface SimulatedOptions {
  /** Base seed (default: hash of the symbol, like MockFeed). Mixed with the UTC day. */
  seed?: number;
  /** Simulator step (ms). The step grid is anchored at UTC midnight. */
  stepMs?: number;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const DAY = 86_400_000;

/**
 * Simulated history for MockFeed instruments, deterministic by (seed, UTC day): the simulator
 * always starts at UTC midnight with the same seed and runs on a fixed step grid, so any two
 * ranges inside the same day see exactly the same market. Records trades and every book delta.
 */
export class SimulatedRecorder {
  readonly instrument: Instrument;
  private sim: MarketSimulator;
  private readonly stepMs: number;
  private readonly trades: Trade[] = [];
  private readonly deltas = new DeltaLog(1 << 16);
  private readonly scratchT: Trade[] = [];
  private readonly scratchD: BookDelta[] = [];
  private initialBook: BookSnapshot | undefined;
  readonly start: number;
  readonly end: number;

  constructor(
    instrumentId: string,
    from: number,
    to: number,
    private layers: ReplayLayers = DEFAULT_LAYERS,
    opts: SimulatedOptions = {},
  ) {
    const m = findMockInstrument(instrumentId.replace(/^mock:/, ''));
    if (!m) throw new Error(`No simulated data for ${instrumentId}`);
    this.instrument = m.instrument;
    this.stepMs = opts.stepMs ?? 250;
    const day = Math.floor(from / DAY);
    const seed =
      ((opts.seed ?? hashString(m.instrument.symbol)) ^ Math.imul(day, 0x9e3779b1)) >>> 0;
    this.sim = new MarketSimulator({ ...m.sim, seed }, day * DAY);
    this.start = day * DAY + Math.floor((from - day * DAY) / this.stepMs) * this.stepMs;
    this.end = Math.max(this.start, to);
  }

  /** Runs up to `budgetMs` of CPU; returns true when the dataset is complete. */
  run(budgetMs = Infinity): boolean {
    const t0 = performance.now();
    const sim = this.sim;
    let n = 0;
    while (sim.t < this.start) {
      sim.step(Math.min(this.stepMs, this.start - sim.t), this.scratchT, this.scratchD);
      this.scratchT.length = 0;
      this.scratchD.length = 0;
      if (++n % 512 === 0 && performance.now() - t0 > budgetMs) return false;
    }
    if (!this.initialBook && this.layers.depth) this.initialBook = sim.snapshot();
    while (sim.t < this.end) {
      sim.step(Math.min(this.stepMs, this.end - sim.t), this.scratchT, this.scratchD);
      if (this.layers.ticks) for (const t of this.scratchT) this.trades.push(t);
      // Book changes take effect at the end of the step (like MockFeed's live batches).
      if (this.layers.depth) for (const d of this.scratchD) this.deltas.push(sim.t, d);
      this.scratchT.length = 0;
      this.scratchD.length = 0;
      if (++n % 512 === 0 && performance.now() - t0 > budgetMs) return false;
    }
    return true;
  }

  /** Fraction of the simulation done (0..1), for a progress bar. */
  progress(): number {
    const day0 = Math.floor(this.start / DAY) * DAY;
    return Math.min(1, (this.sim.t - day0) / Math.max(1, this.end - day0));
  }

  dataset(): ReplayDataset {
    if (!this.run()) throw new Error('unreachable');
    return {
      instrument: this.instrument,
      start: this.start,
      end: this.end,
      trades: this.trades,
      snapshots: [],
      deltas: this.deltas.trim(),
      initialBook: this.initialBook,
    };
  }
}

export function simulatedDataset(
  instrumentId: string,
  from: number,
  to: number,
  layers: ReplayLayers = DEFAULT_LAYERS,
  opts: SimulatedOptions = {},
): ReplayDataset {
  return new SimulatedRecorder(instrumentId, from, to, layers, opts).dataset();
}

/** Simulated data source: every past day of every MockFeed instrument, generated on demand. */
export class SimulatedSource implements ReplayDataSource {
  readonly id = 'simulated';
  readonly label = 'Simulated history (generated)';

  constructor(
    private now: () => number = Date.now,
    /** Days back that can be replayed. */
    private days = 7,
    private opts: SimulatedOptions = {},
  ) {}

  covers(instrumentId: string): boolean {
    return !!findMockInstrument(instrumentId.replace(/^mock:/, ''));
  }

  range(instrumentId: string): Promise<{ from: number; to: number } | null> {
    if (!this.covers(instrumentId)) return Promise.resolve(null);
    const to = this.now();
    return Promise.resolve({ from: Math.floor(to / DAY) * DAY - (this.days - 1) * DAY, to });
  }

  info(instrumentId: string, from: number, to: number): Promise<ReplayDataInfo> {
    const m = findMockInstrument(instrumentId.replace(/^mock:/, ''));
    const sec = Math.max(0, to - from) / 1000;
    const trades = m ? Math.round(m.sim.orderRate * 1.05 * sec) : 0;
    const deltas = m ? Math.round(m.sim.levels * 0.45 * sec) : 0;
    return Promise.resolve({
      where: 'generated',
      bytes: trades * 48 + deltas * 21,
      days: this.days,
      trades,
      note: 'Simulator, deterministic per day',
    });
  }

  /** Generates in slices of a few ms so the UI stays responsive. */
  async load(
    instrumentId: string,
    from: number,
    to: number,
    layers: ReplayLayers = DEFAULT_LAYERS,
    onProgress?: (p: number) => void,
  ): Promise<ReplayDataset> {
    const rec = new SimulatedRecorder(instrumentId, from, to, layers, this.opts);
    while (!rec.run(24)) {
      onProgress?.(rec.progress());
      await new Promise((r) => setTimeout(r, 0));
    }
    onProgress?.(1);
    return rec.dataset();
  }
}

/** In-memory history of any instrument the app has open (live connectors and simulator). */
export class MemorySource implements ReplayDataSource {
  readonly id = 'memory';
  readonly label = 'Session memory (this run)';

  constructor(private lookup: (instrumentId: string) => RecordedHistory | undefined) {}

  covers(instrumentId: string): boolean {
    const h = this.lookup(instrumentId);
    return !!h && h.trades.length > 1;
  }

  range(instrumentId: string): Promise<{ from: number; to: number } | null> {
    const h = this.lookup(instrumentId);
    if (!h || h.trades.length < 2) return Promise.resolve(null);
    return Promise.resolve({ from: h.trades[0]!.ts, to: h.trades[h.trades.length - 1]!.ts });
  }

  info(instrumentId: string, from: number, to: number): Promise<ReplayDataInfo> {
    const h = this.lookup(instrumentId);
    if (!h) return Promise.resolve({ where: 'memory', bytes: 0, days: 0, trades: 0 });
    const n = upperBoundTrades(h.trades, to) - lowerBoundTrades(h.trades, from);
    const cols = h.depth.filter((c) => c.t >= from && c.t <= to);
    const span = h.trades.length ? h.trades[h.trades.length - 1]!.ts - h.trades[0]!.ts : 0;
    return Promise.resolve({
      where: 'memory',
      bytes: n * 48 + cols.reduce((a, c) => a + c.pxs.length * 8, 0),
      days: span / DAY,
      trades: n,
      note: cols.length ? `${cols.length} depth columns` : 'No depth history in range',
    });
  }

  load(
    instrumentId: string,
    from: number,
    to: number,
    layers: ReplayLayers = DEFAULT_LAYERS,
  ): Promise<ReplayDataset> {
    const h = this.lookup(instrumentId);
    if (!h) return Promise.reject(new Error(`No data in memory for ${instrumentId}`));
    return Promise.resolve(datasetFromHistory(h, from, to, layers));
  }
}
