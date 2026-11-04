import { BarSeries, specKey, type BarSpec } from './aggregator';
import { OrderBook } from './orderBook';
import type {
  DepthColumn,
  EventBatch,
  FeedSource,
  FeedStatus,
  HistoryData,
  Instrument,
  Trade,
} from './types';

export interface MarketStoreOptions {
  depthIntervalMs?: number;
  maxDepthColumns?: number;
  maxTrades?: number;
  depthLevels?: number;
}

/**
 * Per-instrument store on the UI side: book, trades, depth history and shared bar series.
 * Two charts with the same (instrument, bar type) share one BarSeries (Live Pipeline stage 7).
 */
export class MarketStore {
  readonly book = new OrderBook();
  trades: Trade[] = [];
  depth: DepthColumn[] = [];
  status: FeedStatus = { state: 'connecting', latencyMs: 0, msgsPerSec: 0 };
  ready = false;
  error: string | null = null;
  /** Bumped on every ingest. */
  version = 0;
  /** Time of the first live event (history/live seam). */
  liveFrom = Number.NaN;
  lastTs = 0;
  private series = new Map<string, BarSeries>();
  private listeners = new Set<() => void>();
  private tradeListeners = new Set<(trades: Trade[]) => void>();
  private lastDepthT = 0;
  private readonly opts: Required<MarketStoreOptions>;

  constructor(
    readonly instrument: Instrument,
    options: MarketStoreOptions = {},
  ) {
    this.opts = {
      depthIntervalMs: options.depthIntervalMs ?? 250,
      maxDepthColumns: options.maxDepthColumns ?? 7200,
      maxTrades: options.maxTrades ?? 3_000_000,
      depthLevels: options.depthLevels ?? 150,
    };
  }

  get lastTrade(): Trade | undefined {
    return this.trades[this.trades.length - 1];
  }

  loadHistory(h: HistoryData): void {
    this.trades = h.trades.slice();
    this.depth = h.depth.slice();
    this.book.applySnapshot(h.book);
    this.lastDepthT = this.depth.length ? this.depth[this.depth.length - 1]!.t : h.end;
    this.lastTs = h.end;
    for (const s of this.series.values()) {
      s.bars.length = 0;
      s.addAll(this.trades);
    }
    this.ready = true;
    this.bump();
  }

  ingest(batch: EventBatch): void {
    if (batch.snapshot) this.book.applySnapshot(batch.snapshot);
    if (batch.deltas.length) this.book.applyDeltas(batch.deltas);
    if (batch.trades.length) {
      if (Number.isNaN(this.liveFrom)) this.liveFrom = batch.trades[0]!.ts;
      for (const t of batch.trades) this.trades.push(t);
      for (const s of this.series.values()) for (const t of batch.trades) s.add(t);
      for (const l of this.tradeListeners) l(batch.trades);
      if (this.trades.length > this.opts.maxTrades) {
        this.trades = this.trades.slice(Math.floor(this.opts.maxTrades * 0.1));
      }
    }
    this.lastTs = batch.ts;
    if (
      batch.ts - this.lastDepthT >= this.opts.depthIntervalMs &&
      !Number.isNaN(this.book.bestBid)
    ) {
      this.depth.push(this.sampleDepth(batch.ts));
      this.lastDepthT = batch.ts;
      if (this.depth.length > this.opts.maxDepthColumns) {
        this.depth.splice(0, this.depth.length - this.opts.maxDepthColumns);
      }
    }
    this.bump();
  }

  setStatus(s: FeedStatus): void {
    this.status = s;
    this.bump();
  }

  /** Shared, live-updating bar series for a bar type. */
  getSeries(spec: BarSpec): BarSeries {
    const key = specKey(spec);
    let s = this.series.get(key);
    if (!s) {
      s = BarSeries.build(spec, this.trades);
      this.series.set(key, s);
    }
    return s;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Live trades as they arrive (paper engine, alerts). */
  onTrades(fn: (trades: Trade[]) => void): () => void {
    this.tradeListeners.add(fn);
    return () => this.tradeListeners.delete(fn);
  }

  /** Trades in [from, to] (binary search on time). */
  tradesBetween(from: number, to: number): Trade[] {
    const a = lowerBound(this.trades, from);
    const b = lowerBound(this.trades, to + 1e-9);
    return this.trades.slice(a, b);
  }

  private sampleDepth(t: number): DepthColumn {
    const L = this.opts.depthLevels;
    const bb = this.book.bestBid;
    const ba = this.book.bestAsk;
    const pxs: number[] = [];
    const qs: number[] = [];
    for (const [px, q] of this.book.bids) {
      if (px > bb - L) {
        pxs.push(px);
        qs.push(q);
      }
    }
    for (const [px, q] of this.book.asks) {
      if (px < ba + L) {
        pxs.push(px);
        qs.push(q);
      }
    }
    return { t, bestBid: bb, bestAsk: ba, pxs: Int32Array.from(pxs), qtys: Float32Array.from(qs) };
  }

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

function lowerBound(trades: readonly Trade[], t: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type FeedFactory = (instrumentId: string) => FeedSource;

/** Owns one feed + store per instrument; windows share them (ref-counted, with a disposal grace period). */
export class MarketHub {
  private entries = new Map<
    string,
    {
      store: MarketStore;
      feed: FeedSource;
      refs: number;
      unsub: () => void;
      dispose: ReturnType<typeof setTimeout> | null;
    }
  >();
  private created = new Set<(s: MarketStore) => void>();

  constructor(
    private factory: FeedFactory,
    /** Delay before an unused feed is stopped (also absorbs React StrictMode double effects). */
    private graceMs = 3000,
  ) {}

  setFactory(factory: FeedFactory): void {
    this.factory = factory;
  }

  /** Returns the store for an instrument, creating (and starting) it if needed. Does not change ref counts. */
  ensure(instrumentId: string): MarketStore {
    const e = this.entries.get(instrumentId);
    if (e) return e.store;
    const feed = this.factory(instrumentId);
    const store = new MarketStore(feed.instrument);
    const u1 = feed.subscribe((b) => {
      if (store.ready) store.ingest(b);
    });
    const u2 = feed.onStatus((s) => store.setStatus(s));
    this.entries.set(instrumentId, {
      store,
      feed,
      refs: 0,
      unsub: () => (u1(), u2()),
      dispose: null,
    });
    for (const fn of this.created) fn(store);
    feed
      .history()
      .then((h) => {
        if (this.entries.get(instrumentId)?.store !== store) return;
        store.loadHistory(h);
        feed.start();
      })
      .catch((err: unknown) => {
        store.error = err instanceof Error ? err.message : String(err);
        store.setStatus({ state: 'error', latencyMs: 0, msgsPerSec: 0, message: store.error });
      });
    this.scheduleDispose(instrumentId);
    return store;
  }

  retain(instrumentId: string): MarketStore {
    const store = this.ensure(instrumentId);
    const e = this.entries.get(instrumentId)!;
    e.refs++;
    if (e.dispose) {
      clearTimeout(e.dispose);
      e.dispose = null;
    }
    return store;
  }

  /** Alias of retain(). */
  acquire(instrumentId: string): MarketStore {
    return this.retain(instrumentId);
  }

  release(instrumentId: string): void {
    const e = this.entries.get(instrumentId);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs === 0) this.scheduleDispose(instrumentId);
  }

  private scheduleDispose(instrumentId: string): void {
    const e = this.entries.get(instrumentId);
    if (!e || e.refs > 0) return;
    if (e.dispose) clearTimeout(e.dispose);
    e.dispose = setTimeout(() => {
      const cur = this.entries.get(instrumentId);
      if (!cur || cur.refs > 0) return;
      cur.feed.stop();
      cur.unsub();
      this.entries.delete(instrumentId);
    }, this.graceMs);
  }

  stores(): MarketStore[] {
    return [...this.entries.values()].map((e) => e.store);
  }

  peek(instrumentId: string): MarketStore | undefined {
    return this.entries.get(instrumentId)?.store;
  }

  /** Notified when a new instrument store is created. */
  onStore(fn: (s: MarketStore) => void): () => void {
    this.created.add(fn);
    return () => this.created.delete(fn);
  }
}
