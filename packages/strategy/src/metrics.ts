import { Rng } from '@htflow/market-data';
import type { JournalStats } from '@htflow/trading';

/** Journal stats plus the risk-adjusted ratios a backtest report needs. */
export interface StrategyStats extends JournalStats {
  /** Mean / sample standard deviation of per-trade net P&L (not annualised). */
  sharpe: number;
  /** Mean / downside deviation of per-trade net P&L (not annualised). */
  sortino: number;
  /** 95th percentile of the max drawdown over Monte-Carlo reshuffles of the trade order. */
  monteCarloDd95: number;
  /** Net P&L as a fraction of the starting balance. */
  returnPct: number;
  /** Mean bars between entry and exit. */
  avgBarsHeld: number;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Sharpe of a return series: mean / sample std (0 with fewer than two values or zero spread). */
export function sharpeRatio(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (xs.length - 1));
  return sd > 0 ? m / sd : 0;
}

/** Sortino of a return series: mean / downside deviation (√(Σ min(0,x)² / n)). */
export function sortinoRatio(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const m = mean(xs);
  let d = 0;
  for (const x of xs) if (x < 0) d += x * x;
  const dd = Math.sqrt(d / xs.length);
  return dd > 0 ? m / dd : m > 0 ? Infinity : 0;
}

/** Max peak-to-trough drawdown of cumulative P&L. */
export function maxDrawdownOf(nets: readonly number[]): number {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const n of nets) {
    eq += n;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}

/**
 * Monte-Carlo worst drawdown (P42): reshuffles the trade order `runs` times with a fixed seed
 * (deterministic) and returns the given percentile of the max drawdowns.
 */
export function monteCarloDrawdown(
  nets: readonly number[],
  runs = 500,
  percentile = 0.95,
  seed = 0x5eed,
): number {
  if (nets.length < 2) return maxDrawdownOf(nets);
  const rng = new Rng(seed);
  const a = nets.slice();
  const dds: number[] = [];
  for (let r = 0; r < runs; r++) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = a[i]!;
      a[i] = a[j]!;
      a[j] = t;
    }
    dds.push(maxDrawdownOf(a));
  }
  dds.sort((x, y) => x - y);
  return dds[Math.min(dds.length - 1, Math.floor(percentile * dds.length))]!;
}
