import type { Trade } from '@htflow/market-data';
import { sessionStart } from '@htflow/tape';

/**
 * Last-price history (one point per second with trades, kept for `horizonMs`) plus session
 * open / high / low / VWAP. Prices are ticks.
 */
export class PriceTracker {
  private secs: number[] = [];
  private pxs: number[] = [];
  private head = 0;
  last = Number.NaN;
  lastTs = Number.NaN;
  sessionFrom = Number.NaN;
  open = Number.NaN;
  high = Number.NaN;
  low = Number.NaN;
  private pv = 0;
  private v = 0;

  constructor(
    readonly horizonMs = 2 * 3_600_000,
    readonly sessionStartHourUtc = 0,
  ) {}

  add(t: Trade): void {
    const s = sessionStart(t.ts, this.sessionStartHourUtc);
    if (s !== this.sessionFrom) {
      this.sessionFrom = s;
      this.open = t.px;
      this.high = t.px;
      this.low = t.px;
      this.pv = 0;
      this.v = 0;
    }
    if (t.px > this.high) this.high = t.px;
    if (t.px < this.low) this.low = t.px;
    this.pv += t.px * t.qty;
    this.v += t.qty;
    this.last = t.px;
    this.lastTs = t.ts;
    const sec = Math.floor(t.ts / 1000);
    const n = this.secs.length;
    if (n > this.head && this.secs[n - 1] === sec) this.pxs[n - 1] = t.px;
    else {
      this.secs.push(sec);
      this.pxs.push(t.px);
    }
    const oldest = sec - Math.ceil(this.horizonMs / 1000);
    while (this.head < this.secs.length && this.secs[this.head]! < oldest) this.head++;
    if (this.head > 4096) {
      this.secs = this.secs.slice(this.head);
      this.pxs = this.pxs.slice(this.head);
      this.head = 0;
    }
  }

  /** Last price at or before time `t`; NaN when the history does not reach back that far. */
  priceAt(t: number): number {
    const sec = Math.floor(t / 1000);
    let lo = this.head;
    let hi = this.secs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.secs[mid]! <= sec) lo = mid + 1;
      else hi = mid;
    }
    return lo > this.head ? this.pxs[lo - 1]! : Number.NaN;
  }

  /** Session VWAP (fractional ticks). */
  get vwap(): number {
    return this.v > 0 ? this.pv / this.v : Number.NaN;
  }

  /** `points` prices sampled every `stepMs` ending at `now` (oldest first). */
  sparkline(now: number, points = 30, stepMs = 60_000): number[] {
    const out: number[] = [];
    for (let k = points - 1; k >= 0; k--) out.push(this.priceAt(now - k * stepMs));
    return out;
  }
}

export interface PriceChangeRow {
  last: number;
  /** Change in ticks. */
  ticks5m: number;
  ticks1h: number;
  ticksDay: number;
  pct5m: number;
  pct1h: number;
  pctDay: number;
  /** Where the last price sits in the session range: 0 = low, 1 = high. */
  rangePos: number;
  high: number;
  low: number;
  open: number;
  vwap: number;
  vsVwapPct: number;
  vsVwapTicks: number;
}

const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / b) * 100 : Number.NaN);

export function priceChange(p: PriceTracker, now: number): PriceChangeRow {
  const last = p.last;
  const sessionLive = !Number.isNaN(p.sessionFrom) && now < p.sessionFrom + 86_400_000;
  const p5 = p.priceAt(now - 300_000);
  const p60 = p.priceAt(now - 3_600_000);
  const open = sessionLive ? p.open : Number.NaN;
  const range = p.high - p.low;
  const vwap = sessionLive ? p.vwap : Number.NaN;
  return {
    last,
    ticks5m: last - p5,
    ticks1h: last - p60,
    ticksDay: last - open,
    pct5m: pct(last, p5),
    pct1h: pct(last, p60),
    pctDay: pct(last, open),
    rangePos: !sessionLive ? Number.NaN : range > 0 ? (last - p.low) / range : 0.5,
    high: p.high,
    low: p.low,
    open,
    vwap,
    vsVwapPct: pct(last, vwap),
    vsVwapTicks: last - vwap,
  };
}

/**
 * Money value of a move of `ticks` for one contract / unit: tickValue per tick for futures,
 * price units (ticks × tickSize) when the instrument has no tick value (linear crypto).
 */
export function moneyChange(ticks: number, inst: { tickSize: number; tickValue: number }): number {
  return inst.tickValue > 0 ? ticks * inst.tickValue : ticks * inst.tickSize;
}
