import type { Trade } from '@htflow/market-data';
import { sessionStart } from '@htflow/tape';

export interface FlowTotals {
  buy: number;
  sell: number;
}

export type PressureSignal = 'strong-buy' | 'strong-sell' | 'neutral';

export interface PressureThresholds {
  /** Buy % at or above which the signal is "Strong buy". */
  strongBuy: number;
  /** Buy % at or below which the signal is "Strong sell". */
  strongSell: number;
}

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = { strongBuy: 65, strongSell: 35 };

/** Aggressive-buy share of aggressor volume, 0–100; NaN when there is no volume. */
export function buyPercent(t: FlowTotals): number {
  const v = t.buy + t.sell;
  return v > 0 ? (t.buy / v) * 100 : Number.NaN;
}

export function pressureSignal(
  pct: number,
  th: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): PressureSignal {
  if (Number.isNaN(pct)) return 'neutral';
  if (pct >= th.strongBuy) return 'strong-buy';
  if (pct <= th.strongSell) return 'strong-sell';
  return 'neutral';
}

/** Validates persisted thresholds (0–100, strongSell < strongBuy). */
export function normalizeThresholds(raw: Partial<Record<keyof PressureThresholds, unknown>> = {}) {
  const n = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : d;
  const strongBuy = n(raw.strongBuy, DEFAULT_PRESSURE_THRESHOLDS.strongBuy);
  const strongSell = n(raw.strongSell, DEFAULT_PRESSURE_THRESHOLDS.strongSell);
  return strongSell < strongBuy ? { strongBuy, strongSell } : { ...DEFAULT_PRESSURE_THRESHOLDS };
}

/**
 * Aggressor buy / sell volume in one-second buckets over a rolling horizon, plus session totals.
 * Trades without a known aggressor are ignored.
 */
export class RollingFlow {
  private readonly n: number;
  private readonly keys: Float64Array;
  private readonly buys: Float64Array;
  private readonly sells: Float64Array;
  private sessionFrom = Number.NaN;
  private sessionTo = Number.NaN;
  readonly session: FlowTotals = { buy: 0, sell: 0 };

  constructor(
    horizonMs = 15 * 60_000,
    readonly sessionStartHourUtc = 0,
  ) {
    this.n = Math.ceil(horizonMs / 1000) + 1;
    this.keys = new Float64Array(this.n).fill(-1);
    this.buys = new Float64Array(this.n);
    this.sells = new Float64Array(this.n);
  }

  add(t: Trade): void {
    if (t.side === 'unknown') return;
    if (Number.isNaN(this.sessionFrom) || t.ts >= this.sessionTo || t.ts < this.sessionFrom) {
      const s = sessionStart(t.ts, this.sessionStartHourUtc);
      if (s !== this.sessionFrom) {
        this.sessionFrom = s;
        this.sessionTo = s + 86_400_000;
        this.session.buy = 0;
        this.session.sell = 0;
      }
    }
    const k = Math.floor(t.ts / 1000);
    const i = k % this.n;
    if (this.keys[i] !== k) {
      this.keys[i] = k;
      this.buys[i] = 0;
      this.sells[i] = 0;
    }
    if (t.side === 'buy') {
      this.buys[i]! += t.qty;
      this.session.buy += t.qty;
    } else {
      this.sells[i]! += t.qty;
      this.session.sell += t.qty;
    }
  }

  /** Totals for trades in the `ms` window ending at `now` (whole seconds). */
  window(now: number, ms: number): FlowTotals {
    const kNow = Math.floor(now / 1000);
    const w = Math.min(this.n, Math.max(1, Math.round(ms / 1000)));
    let buy = 0;
    let sell = 0;
    for (let i = 0; i < this.n; i++) {
      const k = this.keys[i]!;
      if (k > kNow - w && k <= kNow) {
        buy += this.buys[i]!;
        sell += this.sells[i]!;
      }
    }
    return { buy, sell };
  }

  /** Session totals, or zero when `now` is already in a later session than the last trade. */
  sessionTotals(now: number): FlowTotals {
    if (Number.isNaN(this.sessionFrom) || now >= this.sessionTo) return { buy: 0, sell: 0 };
    return { ...this.session };
  }
}

export interface PressureRow {
  m1: number;
  m5: number;
  m15: number;
  session: number;
  /** Aggressor volume in each window (for weighting / tooltips). */
  vol: { m1: number; m5: number; m15: number; session: number };
}

export function marketPressure(flow: RollingFlow, now: number): PressureRow {
  const w1 = flow.window(now, 60_000);
  const w5 = flow.window(now, 300_000);
  const w15 = flow.window(now, 900_000);
  const s = flow.sessionTotals(now);
  return {
    m1: buyPercent(w1),
    m5: buyPercent(w5),
    m15: buyPercent(w15),
    session: buyPercent(s),
    vol: {
      m1: w1.buy + w1.sell,
      m5: w5.buy + w5.sell,
      m15: w15.buy + w15.sell,
      session: s.buy + s.sell,
    },
  };
}
