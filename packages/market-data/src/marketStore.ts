import {
  BarSeries,
  inferCapabilities,
  specKey,
  type BarSpec,
  type FeedCapabilities,
  type SessionRules,
  type SessionSel,
} from './aggregator';
import { OrderBook } from './orderBook';
import type {
  DepthColumn,
  EventBatch,
  FeedSource,
  FeedStatus,
  FundingStat,
  HistoryData,
  HistoryProgress,
  Instrument,
  LiquidationStat,
  MarketStat,
  OpenInterestStat,
  Trade,
} from './types';

/** Resolves RTH / ETH / custom session rules for an instrument (the app wires the market catalog). */
export type SessionResolver = (instrument: Instrument, sel: SessionSel) => SessionRules | null;
let sessionResolver: SessionResolver = () => null;

/** Installs the session resolver used by every MarketStore.getSeries (P07 sessions). */
export function setSessionResolver(fn: SessionResolver): void {
  sessionResolver = fn;
}

export function resolveSession(instrument: Instrument, sel: SessionSel | undefined) {
  return sel && sel !== '24h' ? sessionResolver(instrument, sel) : null;
}

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
  /** Set by the hub when the feed can load older history (lazy left-scroll loading). */
  olderLoader: ((before: number, spanMs: number, anchorPx?: number) => Promise<Trade[]>) | null =
    null;
  loadingOlder = false;
  /** True once the feed returned no older data. */
  historyExhausted = false;
  /** Progress of the older-history download in flight (feeds that report it). */
  historyProgress: HistoryProgress | null = null;
  private series = new Map<string, BarSeries>();
  private listeners = new Set<() => void>();
  private tradeListeners = new Set<(trades: Trade[]) => void>();
  /** Latest funding / open interest, recent liquidations (live derivatives venues only). */
  funding: FundingStat | null = null;
  openInterest: OpenInterestStat | null = null;
  liquidations: LiquidationStat[] = [];
  private fundingListeners = new Set<(f: FundingStat) => void>();
  private oiListeners = new Set<(o: OpenInterestStat) => void>();
  private liqListeners = new Set<(l: LiquidationStat[]) => void>();
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
      s.clear();
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
    if (batch.stats?.length) this.ingestStats(batch.stats);
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

  /** Asks the feed for spanMs of trades before the first loaded one; resolves to the count added. */
  async loadOlder(spanMs = 3_600_000): Promise<number> {
    if (!this.olderLoader || this.loadingOlder || this.historyExhausted || !this.ready) return 0;
    const first = this.trades[0];
    const before = first ? first.ts : this.lastTs;
    this.loadingOlder = true;
    this.bump();
    try {
      const older = await this.olderLoader(before, spanMs, first?.px);
      const n = this.prependTrades(older);
      if (n === 0) this.historyExhausted = true;
      return n;
    } finally {
      this.loadingOlder = false;
      this.bump();
    }
  }

  setHistoryProgress(p: HistoryProgress | null): void {
    this.historyProgress = p;
    this.bump();
  }

  /** Prepends trades older than the first loaded trade and rebuilds every bar series. */
  prependTrades(older: readonly Trade[]): number {
    const first = this.trades[0]?.ts ?? Infinity;
    const add = older.filter((t) => t.ts < first);
    if (!add.length) return 0;
    add.sort((a, b) => a.ts - b.ts);
    this.trades = add.concat(this.trades);
    this.rebuildSeries();
    return add.length;
  }

  /** Rebuilds all shared bar series from the trade list ("Reload all historical data"). */
  rebuildSeries(): void {
    for (const s of this.series.values()) {
      s.bars.length = 0;
      s.addAll(this.trades);
    }
    this.bump();
  }

  private ingestStats(stats: MarketStat[]): void {
    const liq: LiquidationStat[] = [];
    for (const s of stats) {
      if (s.kind === 'funding') {
        this.funding = s;
        for (const l of this.fundingListeners) l(s);
      } else if (s.kind === 'open_interest') {
        this.openInterest = s;
        for (const l of this.oiListeners) l(s);
      } else liq.push(s);
    }
    if (liq.length) {
      this.liquidations.push(...liq);
      if (this.liquidations.length > 5000)
        this.liquidations.splice(0, this.liquidations.length - 5000);
      for (const l of this.liqListeners) l(liq);
    }
  }

  /** Funding rate updates (live perpetuals). */
  onFunding(fn: (f: FundingStat) => void): () => void {
    this.fundingListeners.add(fn);
    return () => this.fundingListeners.delete(fn);
  }

  /** Open interest updates (live futures / perpetuals). */
  onOpenInterest(fn: (o: OpenInterestStat) => void): () => void {
    this.oiListeners.add(fn);
    return () => this.oiListeners.delete(fn);
  }

  /** Liquidations as they arrive. */
  onLiquidation(fn: (l: LiquidationStat[]) => void): () => void {
    this.liqListeners.add(fn);
    return () => this.liqListeners.delete(fn);
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
      s = BarSeries.build(spec, this.trades, resolveSession(this.instrument, spec.session));
      this.series.set(key, s);
    }
    return s;
  }

  /** What the feed supplies (declared by the feed, else inferred from the trades). */
  get capabilities(): FeedCapabilities {
    return this.declaredCapabilities ?? inferCapabilities(this.trades);
  }

  /** Set by the hub from FeedSource.capabilities when the feed declares them. */
  declaredCapabilities: FeedCapabilities | null = null;
  /** Kind of the feed behind this store (simulated feeds generate older history on demand only). */
  feedKind: 'mock' | 'live' | 'replay' | null = null;

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
    store.declaredCapabilities = feed.capabilities ?? null;
    store.feedKind = feed.kind;
    const u1 = feed.subscribe((b) => {
      if (store.ready) store.ingest(b);
    });
    const u2 = feed.onStatus((s) => store.setStatus(s));
    if (feed.historyBefore)
      store.olderLoader = (before, span, anchor) => feed.historyBefore!(before, span, anchor);
    const u3 = feed.onHistoryProgress?.((p) => store.setHistoryProgress(p)) ?? (() => {});
    this.entries.set(instrumentId, {
      store,
      feed,
      refs: 0,
      unsub: () => (u1(), u2(), u3()),
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
