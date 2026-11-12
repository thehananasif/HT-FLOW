import type { OrderBook, Trade } from '@htflow/market-data';
import type { Order } from '@htflow/trading';
import { computeValueArea, type ValueArea } from './analytics';

export type VolumeScope = 'session' | 'range';
export type BookSide = 'bid' | 'ask';

export interface DomModelOptions {
  /** Window for the Sells / Buys (recent executions) columns. */
  recentWindowMs: number;
  /** Reference window for the Limit Δ (size change) columns. */
  changeWindowMs: number;
  /** Volume / delta / VA-POC source: whole session or a rolling range. */
  volumeScope: VolumeScope;
  /** Length of the rolling range when `volumeScope` is 'range'. */
  rangeMs: number;
  /** A level that loses at least this many lots in one update (not explained by fills) flashes "pulled". */
  pulledThreshold: number;
  /** A level that gains at least this many lots in one update (no fills at the price) flashes "stacked". */
  stackedThreshold: number;
  /** How long a pulled / stacked flash stays visible. */
  flashMs: number;
  /** Refills after fills at the same price needed to mark an iceberg. */
  icebergMinRefills: number;
  /** Iceberg marks expire after this much inactivity at the price. */
  icebergTtlMs: number;
  /** Levels on each side of the best price watched for pulled / stacked / iceberg detection. */
  trackTicks: number;
  /** Value area share of volume (0.7 = 70 %). */
  valueAreaPct: number;
}

export const DEFAULT_MODEL_OPTIONS: DomModelOptions = {
  recentWindowMs: 10_000,
  changeWindowMs: 10_000,
  volumeScope: 'session',
  rangeMs: 30 * 60_000,
  pulledThreshold: 20,
  stackedThreshold: 20,
  flashMs: 1_200,
  icebergMinRefills: 2,
  icebergTtlMs: 60_000,
  trackTicks: 25,
  valueAreaPct: 0.7,
};

export interface DepthFlash {
  px: number;
  side: BookSide;
  kind: 'pulled' | 'stacked';
  /** Lots added (+) or removed (−). */
  amount: number;
  at: number;
}

export interface IcebergMark {
  px: number;
  side: BookSide;
  refills: number;
  /** Estimated hidden quantity executed beyond the displayed size. */
  hidden: number;
  /** Total executed at the price while tracked. */
  executed: number;
  lastAt: number;
}

export interface LastPrint {
  qty: number;
  side: Trade['side'];
  ts: number;
}

/** My working orders at one price (Limit tracking column). */
export interface LimitTrack {
  buyQty: number;
  sellQty: number;
  count: number;
  /** Estimated lots ahead of my oldest order at this price (queue position); NaN if unknown. */
  ahead: number;
  stops: number;
}

const add = (m: Map<number, number>, k: number, v: number) => {
  const n = (m.get(k) ?? 0) + v;
  if (Math.abs(n) < 1e-12) m.delete(k);
  else m.set(k, n);
};

/** FIFO of trades with a moving head (no splice per expiry). */
class TradeWindow {
  private q: Trade[] = [];
  private head = 0;
  push(t: Trade): void {
    this.q.push(t);
  }
  /** Removes trades older than `cutoff`, calling `fn` for each. */
  expire(cutoff: number, fn: (t: Trade) => void): void {
    while (this.head < this.q.length && this.q[this.head]!.ts < cutoff) fn(this.q[this.head++]!);
    if (this.head > 4096 && this.head * 2 > this.q.length) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }
  clear(): void {
    this.q = [];
    this.head = 0;
  }
  get size(): number {
    return this.q.length - this.head;
  }
}

/**
 * DOM derived data per price (P15 Smart DOM v2). Everything is incremental: each `update` only
 * consumes the trades that arrived since the previous call and inspects a window of book levels
 * around the inside market, so the cost per frame does not grow with the session length.
 */
export class DomModel {
  readonly opts: DomModelOptions;
  /** Session volume / buys / sells per price. */
  readonly session = new Map<number, number>();
  readonly sessionBuys = new Map<number, number>();
  readonly sessionSells = new Map<number, number>();
  /** Rolling-range volume / buys / sells per price. */
  readonly range = new Map<number, number>();
  readonly rangeBuys = new Map<number, number>();
  readonly rangeSells = new Map<number, number>();
  /** Recent executions (Sells / Buys columns). */
  readonly recentBuys = new Map<number, number>();
  readonly recentSells = new Map<number, number>();
  /** Last print per price. */
  readonly lastPrint = new Map<number, LastPrint>();
  readonly flashes = { bid: new Map<number, DepthFlash>(), ask: new Map<number, DepthFlash>() };
  readonly icebergs = { bid: new Map<number, IcebergMark>(), ask: new Map<number, IcebergMark>() };
  readonly limits = new Map<number, LimitTrack>();
  sessionStart = 0;
  /** Bumped whenever volume maps change (cache key for the value area). */
  volumeVersion = 0;

  private recent = new TradeWindow();
  private rangeQ = new TradeWindow();
  private refBids = new Map<number, number>();
  private refAsks = new Map<number, number>();
  private refAt = Number.NEGATIVE_INFINITY;
  private consumed = 0;
  private source: Trade[] | null = null;
  private primed = false;
  private needRangeRebuild = false;
  /** Fills against resting size since the previous update (bid side = sell aggressor). */
  private execBid = new Map<number, number>();
  private execAsk = new Map<number, number>();
  private prevBid = new Map<number, number>();
  private prevAsk = new Map<number, number>();
  private queue = new Map<string, { ahead: number; px: number; side: BookSide }>();
  private vaCache: { key: string; va: ValueArea } | null = null;

  constructor(opts: Partial<DomModelOptions> = {}) {
    this.opts = { ...DEFAULT_MODEL_OPTIONS, ...opts };
  }

  /** Changes options; a longer range is rebuilt from the source trades on the next update. */
  configure(next: Partial<DomModelOptions>): void {
    const prevRange = this.opts.rangeMs;
    const prevRecent = this.opts.recentWindowMs;
    Object.assign(this.opts, next);
    if (this.opts.rangeMs !== prevRange || this.opts.recentWindowMs !== prevRecent)
      this.needRangeRebuild = true;
    this.vaCache = null;
  }

  /** Forgets everything (new instrument / session). */
  reset(): void {
    this.source = null;
    this.consumed = 0;
    this.primed = false;
    for (const m of [
      this.session,
      this.sessionBuys,
      this.sessionSells,
      this.range,
      this.rangeBuys,
      this.rangeSells,
      this.recentBuys,
      this.recentSells,
      this.execBid,
      this.execAsk,
      this.prevBid,
      this.prevAsk,
      this.refBids,
      this.refAsks,
    ])
      m.clear();
    this.lastPrint.clear();
    this.flashes.bid.clear();
    this.flashes.ask.clear();
    this.icebergs.bid.clear();
    this.icebergs.ask.clear();
    this.limits.clear();
    this.queue.clear();
    this.recent.clear();
    this.rangeQ.clear();
    this.refAt = Number.NEGATIVE_INFINITY;
    this.volumeVersion++;
  }

  /**
   * Consumes new trades from the store's (append-only) trade array, then inspects the book.
   * `orders` are my working orders (read from the paper engine's public API) for limit tracking.
   */
  update(trades: Trade[], book: OrderBook, now: number, orders: readonly Order[] = []): void {
    const start = Math.floor(now / 86_400_000) * 86_400_000;
    if (this.source !== trades || start !== this.sessionStart || this.consumed > trades.length) {
      this.reset();
      this.source = trades;
      this.sessionStart = start;
      this.consumed = lowerBound(trades, start);
    }
    if (this.needRangeRebuild) this.rebuildWindows(trades, now);
    const recentCut = now - this.opts.recentWindowMs;
    const rangeCut = now - this.opts.rangeMs;
    const n = trades.length;
    if (n > this.consumed) this.volumeVersion++;
    for (let i = this.consumed; i < n; i++) {
      const t = trades[i]!;
      this.ingest(t, recentCut, rangeCut);
    }
    this.consumed = n;
    this.expire(recentCut, rangeCut);

    if (this.primed) this.inspectBook(book, now);
    this.snapshotWindow(book);
    this.trackLimits(orders, book);
    this.execBid.clear();
    this.execAsk.clear();
    this.primed = true;

    if (now - this.refAt >= this.opts.changeWindowMs) {
      this.refBids = new Map(book.bids);
      this.refAsks = new Map(book.asks);
      this.refAt = now;
    }
    this.expireMarks(now);
  }

  private ingest(t: Trade, recentCut: number, rangeCut: number): void {
    add(this.session, t.px, t.qty);
    if (t.side === 'buy') add(this.sessionBuys, t.px, t.qty);
    else if (t.side === 'sell') add(this.sessionSells, t.px, t.qty);
    if (t.ts >= rangeCut) {
      this.rangeQ.push(t);
      add(this.range, t.px, t.qty);
      if (t.side === 'buy') add(this.rangeBuys, t.px, t.qty);
      else if (t.side === 'sell') add(this.rangeSells, t.px, t.qty);
    }
    if (t.ts >= recentCut) {
      this.recent.push(t);
      if (t.side === 'buy') add(this.recentBuys, t.px, t.qty);
      else if (t.side === 'sell') add(this.recentSells, t.px, t.qty);
    }
    this.lastPrint.set(t.px, { qty: t.qty, side: t.side, ts: t.ts });
    if (this.primed) {
      // A buy aggressor lifts resting asks; a sell aggressor hits resting bids.
      if (t.side === 'buy') add(this.execAsk, t.px, t.qty);
      else if (t.side === 'sell') add(this.execBid, t.px, t.qty);
    }
  }

  private expire(recentCut: number, rangeCut: number): void {
    this.recent.expire(recentCut, (t) => {
      if (t.side === 'buy') add(this.recentBuys, t.px, -t.qty);
      else if (t.side === 'sell') add(this.recentSells, t.px, -t.qty);
    });
    let changed = false;
    this.rangeQ.expire(rangeCut, (t) => {
      changed = true;
      add(this.range, t.px, -t.qty);
      if (t.side === 'buy') add(this.rangeBuys, t.px, -t.qty);
      else if (t.side === 'sell') add(this.rangeSells, t.px, -t.qty);
    });
    if (changed) this.volumeVersion++;
  }

  private rebuildWindows(trades: Trade[], now: number): void {
    this.needRangeRebuild = false;
    this.range.clear();
    this.rangeBuys.clear();
    this.rangeSells.clear();
    this.recentBuys.clear();
    this.recentSells.clear();
    this.rangeQ.clear();
    this.recent.clear();
    const rangeCut = Math.max(this.sessionStart, now - this.opts.rangeMs);
    const recentCut = now - this.opts.recentWindowMs;
    for (let i = lowerBound(trades, rangeCut); i < this.consumed; i++) {
      const t = trades[i]!;
      this.rangeQ.push(t);
      add(this.range, t.px, t.qty);
      if (t.side === 'buy') add(this.rangeBuys, t.px, t.qty);
      else if (t.side === 'sell') add(this.rangeSells, t.px, t.qty);
      if (t.ts >= recentCut) {
        this.recent.push(t);
        if (t.side === 'buy') add(this.recentBuys, t.px, t.qty);
        else if (t.side === 'sell') add(this.recentSells, t.px, t.qty);
      }
    }
    this.volumeVersion++;
  }

  /** Pulled / stacked flashes and iceberg refills on the watched levels. */
  private inspectBook(book: OrderBook, now: number): void {
    this.inspectSide('bid', book.bids, this.prevBid, this.execBid, now);
    this.inspectSide('ask', book.asks, this.prevAsk, this.execAsk, now);
  }

  private inspectSide(
    side: BookSide,
    levels: Map<number, number>,
    prev: Map<number, number>,
    exec: Map<number, number>,
    now: number,
  ): void {
    const o = this.opts;
    const visit = (px: number, before: number, known: boolean) => {
      const cur = levels.get(px) ?? 0;
      const filled = exec.get(px) ?? 0;
      const expected = Math.max(0, before - filled);
      if (filled > 0) {
        const ice = this.icebergs[side];
        let m = ice.get(px);
        if (!m) {
          m = { px, side, refills: 0, hidden: 0, executed: 0, lastAt: now };
          ice.set(px, m);
        }
        m.executed += filled;
        m.lastAt = now;
        // Size at the price came back (or never went down) although it was hit: a refill.
        if (known && cur > expected + 1e-9 && cur > 0) {
          m.refills++;
          m.hidden += Math.min(filled, cur - expected);
        }
        return;
      }
      const change = cur - expected;
      if (change <= -o.pulledThreshold && o.pulledThreshold > 0)
        this.flashes[side].set(px, { px, side, kind: 'pulled', amount: change, at: now });
      else if (change >= o.stackedThreshold && o.stackedThreshold > 0)
        this.flashes[side].set(px, { px, side, kind: 'stacked', amount: change, at: now });
    };
    for (const [px, before] of prev) visit(px, before, true);
    // Fills at prices we were not watching still add to the executed total (no refill test).
    for (const [px] of exec) if (!prev.has(px)) visit(px, 0, false);
  }

  private snapshotWindow(book: OrderBook): void {
    const k = this.opts.trackTicks;
    this.prevBid.clear();
    this.prevAsk.clear();
    const bb = book.bestBid;
    const ba = book.bestAsk;
    if (!Number.isNaN(bb))
      for (let px = bb - k; px <= bb; px++) this.prevBid.set(px, book.bids.get(px) ?? 0);
    if (!Number.isNaN(ba))
      for (let px = ba; px <= ba + k; px++) this.prevAsk.set(px, book.asks.get(px) ?? 0);
  }

  /** Queue-position estimate for each working limit order, aggregated per price. */
  private trackLimits(orders: readonly Order[], book: OrderBook): void {
    this.limits.clear();
    const seen = new Set<string>();
    for (const ord of orders) {
      const isStop = ord.type !== 'limit' && ord.type !== 'market';
      const px = ord.type === 'limit' ? ord.px : (ord.stopPx ?? ord.px);
      if (px === undefined) continue;
      const rest = ord.qty - ord.filled;
      let l = this.limits.get(px);
      if (!l) {
        l = { buyQty: 0, sellQty: 0, count: 0, ahead: Number.NaN, stops: 0 };
        this.limits.set(px, l);
      }
      l.count++;
      if (ord.side === 'buy') l.buyQty += rest;
      else l.sellQty += rest;
      if (isStop) {
        l.stops++;
        continue;
      }
      seen.add(ord.id);
      const side: BookSide = ord.side === 'buy' ? 'bid' : 'ask';
      const levels = side === 'bid' ? book.bids : book.asks;
      const size = levels.get(px) ?? 0;
      let q = this.queue.get(ord.id);
      if (!q || q.px !== px) {
        // New (or moved) order joins the back of the queue.
        q = { ahead: size, px, side };
        this.queue.set(ord.id, q);
      } else {
        const filled = (side === 'bid' ? this.execBid : this.execAsk).get(px) ?? 0;
        q.ahead = Math.max(0, Math.min(q.ahead - filled, size));
      }
      l.ahead = Number.isNaN(l.ahead) ? q.ahead : Math.min(l.ahead, q.ahead);
    }
    for (const id of [...this.queue.keys()]) if (!seen.has(id)) this.queue.delete(id);
  }

  private expireMarks(now: number): void {
    for (const side of ['bid', 'ask'] as const) {
      for (const [px, f] of this.flashes[side])
        if (now - f.at > this.opts.flashMs) this.flashes[side].delete(px);
      for (const [px, m] of this.icebergs[side])
        if (now - m.lastAt > this.opts.icebergTtlMs) this.icebergs[side].delete(px);
    }
  }

  /** Iceberg mark at a price once it reached the refill threshold. */
  iceberg(side: BookSide, px: number): IcebergMark | undefined {
    const m = this.icebergs[side].get(px);
    return m && m.refills >= this.opts.icebergMinRefills ? m : undefined;
  }

  flash(side: BookSide, px: number): DepthFlash | undefined {
    return this.flashes[side].get(px);
  }

  /** Volume map for the selected scope. */
  get volume(): Map<number, number> {
    return this.opts.volumeScope === 'range' ? this.range : this.session;
  }

  get buys(): Map<number, number> {
    return this.opts.volumeScope === 'range' ? this.rangeBuys : this.sessionBuys;
  }

  get sells(): Map<number, number> {
    return this.opts.volumeScope === 'range' ? this.rangeSells : this.sessionSells;
  }

  /** Ask-aggressor minus bid-aggressor volume at a price (selected scope). */
  deltaAt(px: number): number {
    return (this.buys.get(px) ?? 0) - (this.sells.get(px) ?? 0);
  }

  /** POC / VAH / VAL of the selected scope; recomputed only when volume changed. */
  valueArea(): ValueArea {
    const key = `${this.opts.volumeScope}:${this.volumeVersion}:${this.opts.valueAreaPct}`;
    if (this.vaCache?.key === key) return this.vaCache.va;
    const va = computeValueArea(this.volume, this.opts.valueAreaPct);
    this.vaCache = { key, va };
    return va;
  }

  bidChange(px: number, book: OrderBook): number {
    return (book.bids.get(px) ?? 0) - (this.refBids.get(px) ?? 0);
  }

  askChange(px: number, book: OrderBook): number {
    return (book.asks.get(px) ?? 0) - (this.refAsks.get(px) ?? 0);
  }
}

function lowerBound(trades: Trade[], ts: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (trades[m]!.ts < ts) lo = m + 1;
    else hi = m;
  }
  return lo;
}
