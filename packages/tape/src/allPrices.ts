import type { Trade } from '@htflow/market-data';

/** Per-price statistics (All Prices window). bidVol = sold into the bid, askVol = bought at the ask. */
export interface PriceLevelStats {
  px: number;
  volume: number;
  bidVol: number;
  askVol: number;
  /** askVol − bidVol. */
  delta: number;
  trades: number;
  /** Time the last traded price spent at this price, ms. */
  timeMs: number;
  /** Time of the last trade at this price, epoch ms. */
  lastSeen: number;
}

export type RangeKind = 'session' | 'visible' | 'week';

export interface RangeOptions {
  /** Session start, hours after 00:00 UTC (0–23). */
  sessionStartHourUtc: number;
  /** Length of the rolling "Visible" range, ms. */
  visibleMs: number;
}

export const DEFAULT_RANGE_OPTIONS: RangeOptions = { sessionStartHourUtc: 0, visibleMs: 3_600_000 };

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Start of the trading session containing `now` (session opens `startHourUtc` hours after 00:00 UTC). */
export function sessionStart(now: number, startHourUtc = 0): number {
  const off = (((Math.round(startHourUtc) % 24) + 24) % 24) * HOUR;
  return Math.floor((now - off) / DAY) * DAY + off;
}

/** Start of the trading week (Monday's session open) containing `now`. */
export function weekStart(now: number, startHourUtc = 0): number {
  const s = sessionStart(now, startHourUtc);
  const off = s - Math.floor(s / DAY) * DAY;
  const day = Math.floor(s / DAY);
  // 1970-01-01 was a Thursday: (day + 3) % 7 → 0 = Monday.
  const weekday = (((day + 3) % 7) + 7) % 7;
  return (day - weekday) * DAY + off;
}

export function rangeStart(kind: RangeKind, now: number, o: RangeOptions = DEFAULT_RANGE_OPTIONS) {
  if (kind === 'visible') return now - Math.max(60_000, o.visibleMs);
  if (kind === 'week') return weekStart(now, o.sessionStartHourUtc);
  return sessionStart(now, o.sessionStartHourUtc);
}

/** First index with trade.ts ≥ t. */
export function lowerBoundTs(trades: readonly Trade[], t: number): number {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trades[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Incremental per-price statistics. Time-at-price attributes the gap between consecutive trades
 * to the earlier trade's price, capped at `maxGapMs` (market closed / feed gaps do not count).
 */
export class PriceStatsAccumulator {
  readonly levels = new Map<number, PriceLevelStats>();
  totalVolume = 0;
  totalTrades = 0;
  lastPx = Number.NaN;
  lastTs = Number.NaN;

  constructor(readonly maxGapMs = 300_000) {}

  private level(px: number): PriceLevelStats {
    let l = this.levels.get(px);
    if (!l) {
      l = { px, volume: 0, bidVol: 0, askVol: 0, delta: 0, trades: 0, timeMs: 0, lastSeen: 0 };
      this.levels.set(px, l);
    }
    return l;
  }

  add(t: Trade): void {
    if (!Number.isNaN(this.lastPx)) {
      const gap = Math.min(this.maxGapMs, Math.max(0, t.ts - this.lastTs));
      this.level(this.lastPx).timeMs += gap;
    }
    const l = this.level(t.px);
    l.volume += t.qty;
    if (t.side === 'buy') {
      l.askVol += t.qty;
      l.delta += t.qty;
    } else if (t.side === 'sell') {
      l.bidVol += t.qty;
      l.delta -= t.qty;
    }
    l.trades++;
    l.lastSeen = t.ts;
    this.totalVolume += t.qty;
    this.totalTrades++;
    this.lastPx = t.px;
    this.lastTs = t.ts;
  }

  addRange(trades: readonly Trade[], from = 0, to = trades.length): void {
    for (let i = from; i < to; i++) this.add(trades[i]!);
  }

  /** Copy of every level; when `now` is given the current price also gets the still-open interval. */
  snapshot(now?: number): PriceLevelStats[] {
    const out: PriceLevelStats[] = [];
    for (const l of this.levels.values()) out.push({ ...l });
    if (now !== undefined && !Number.isNaN(this.lastPx)) {
      const cur = out.find((l) => l.px === this.lastPx);
      if (cur) cur.timeMs += Math.min(this.maxGapMs, Math.max(0, now - this.lastTs));
    }
    return out;
  }
}

/** Point of control: price with the most volume (ties → lower price). NaN when empty. */
export function pocOf(levels: Iterable<PriceLevelStats>): number {
  let best = Number.NaN;
  let vol = -1;
  for (const l of levels) {
    if (l.volume > vol || (l.volume === vol && l.px < best)) {
      vol = l.volume;
      best = l.px;
    }
  }
  return best;
}

/** Statistics for trades with from ≤ ts < to. */
export function priceStats(
  trades: readonly Trade[],
  from: number,
  to: number = Number.POSITIVE_INFINITY,
  now?: number,
): { levels: PriceLevelStats[]; poc: number; totalVolume: number; totalTrades: number } {
  const acc = new PriceStatsAccumulator();
  acc.addRange(trades, lowerBoundTs(trades, from), lowerBoundTs(trades, to));
  const levels = acc.snapshot(now);
  return { levels, poc: pocOf(levels), totalVolume: acc.totalVolume, totalTrades: acc.totalTrades };
}

/** Merges levels into rows of `ticksPerRow` ticks (row price = floor to the row size). */
export function groupLevels(levels: readonly PriceLevelStats[], ticksPerRow: number) {
  const g = Math.max(1, Math.round(ticksPerRow));
  if (g === 1) return levels.map((l) => ({ ...l }));
  const m = new Map<number, PriceLevelStats>();
  for (const l of levels) {
    const px = Math.floor(l.px / g) * g;
    const r = m.get(px);
    if (!r) m.set(px, { ...l, px });
    else {
      r.volume += l.volume;
      r.bidVol += l.bidVol;
      r.askVol += l.askVol;
      r.delta += l.delta;
      r.trades += l.trades;
      r.timeMs += l.timeMs;
      r.lastSeen = Math.max(r.lastSeen, l.lastSeen);
    }
  }
  return [...m.values()];
}

const GROUP_STEPS = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2500, 5000, 10000];

/** Smallest "nice" row size that fits the price range into at most `maxRows` rows. */
export function autoGrouping(rangeTicks: number, maxRows = 120): number {
  for (const g of GROUP_STEPS) if (rangeTicks / g <= maxRows) return g;
  return GROUP_STEPS[GROUP_STEPS.length - 1]!;
}

export type LevelSortKey = keyof PriceLevelStats;

export function sortLevels(
  levels: PriceLevelStats[],
  key: LevelSortKey,
  dir: 'asc' | 'desc',
): PriceLevelStats[] {
  const s = dir === 'asc' ? 1 : -1;
  return levels.sort((a, b) => (a[key] - b[key]) * s || (b.px - a.px) * s);
}

/** Best bid/ask at time `ts` from sampled depth columns (newest column at or before ts). */
export function quoteAt(
  cols: readonly { t: number; bestBid: number; bestAsk: number }[],
  ts: number,
  maxAgeMs = 2000,
): [number, number] {
  let lo = 0;
  let hi = cols.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cols[mid]!.t <= ts) lo = mid + 1;
    else hi = mid;
  }
  const c = cols[lo - 1];
  if (!c || ts - c.t > maxAgeMs) return [Number.NaN, Number.NaN];
  return [c.bestBid, c.bestAsk];
}

/**
 * Follows an append-only trade array (MarketStore.trades) and yields the index range not yet
 * consumed. When the array is replaced (history reload / trimming) it resyncs by timestamp.
 */
export class TradeCursor {
  private arr: readonly Trade[] | null = null;
  private idx = 0;
  private lastTs = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.arr = null;
    this.idx = 0;
    this.lastTs = Number.NEGATIVE_INFINITY;
  }

  /** Starts consuming at the first trade with ts ≥ t. */
  seek(trades: readonly Trade[], t: number): void {
    this.arr = trades;
    this.idx = lowerBoundTs(trades, t);
    this.lastTs = this.idx > 0 ? trades[this.idx - 1]!.ts : Number.NEGATIVE_INFINITY;
  }

  next(trades: readonly Trade[]): [number, number] {
    if (trades !== this.arr) {
      this.arr = trades;
      this.idx = lowerBoundTs(trades, this.lastTs + 1e-9);
    }
    const from = Math.min(this.idx, trades.length);
    const to = trades.length;
    this.idx = to;
    if (to > from) this.lastTs = trades[to - 1]!.ts;
    return [from, to];
  }
}
