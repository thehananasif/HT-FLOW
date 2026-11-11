import { normCdf } from './normal';
import {
  greeks,
  intrinsic,
  optionPrice,
  yearFrac,
  type Greeks,
  type OptionKind,
  type PricingModel,
} from './pricing';

export type LegKind = OptionKind | 'underlying';

/** One leg of a multi-leg position. Prices are per unit of the underlying. */
export interface Leg {
  id: string;
  kind: LegKind;
  /** Strike (ignored for `underlying`). */
  strike: number;
  /** Expiry, epoch ms (ignored for `underlying`). */
  expiry: number;
  /** Signed quantity in contracts: + long (buy), − short (sell). */
  qty: number;
  /** Entry price per unit (premium paid / received; entry price for `underlying`). */
  premium: number;
  /** Implied volatility used to value the leg before expiry (decimal). */
  iv: number;
  /** Contract name, e.g. BTC-27NOV26-70000-C. */
  name?: string;
  /**
   * Ratio between this leg's own underlying (its futures contract / forward) and the price on the
   * payoff axis. 1 when all legs share one underlying.
   */
  basis?: number;
}

export interface StrategyEnv {
  model: PricingModel;
  /** Risk-free rate, decimal. */
  r: number;
  /** Dividend / funding yield for Black-Scholes, decimal. */
  q?: number;
  /** Currency value of one point per contract (ES = 50, Deribit BTC = 1). */
  multiplier: number;
  /** Valuation time "now", epoch ms. */
  now: number;
}

const optionLegs = (legs: readonly Leg[]) => legs.filter((l) => l.kind !== 'underlying');

/** Earliest option expiry among the legs (the "at expiry" horizon); `now` when there is none. */
export function firstExpiry(legs: readonly Leg[], now: number): number {
  const o = optionLegs(legs);
  return o.length ? Math.min(...o.map((l) => l.expiry)) : now;
}

/** Value per unit of one leg when the axis price is S at time t (ms). */
export function legValue(leg: Leg, S: number, t: number, env: StrategyEnv): number {
  const u = S * (leg.basis ?? 1);
  if (leg.kind === 'underlying') return u;
  if (t >= leg.expiry) return intrinsic(leg.kind, u, leg.strike);
  return optionPrice({
    kind: leg.kind,
    S: u,
    K: leg.strike,
    T: yearFrac(t, leg.expiry),
    r: env.r,
    q: env.q,
    sigma: leg.iv,
    model: env.model,
  });
}

/** Position P/L in currency when the axis price is S at time t (ms). */
export function pnlAt(legs: readonly Leg[], S: number, t: number, env: StrategyEnv): number {
  let v = 0;
  for (const l of legs) v += l.qty * env.multiplier * (legValue(l, S, t, env) - l.premium);
  return v;
}

/** P/L at the earliest expiry (later legs of calendars are valued with their IV). */
export function pnlAtExpiry(legs: readonly Leg[], S: number, env: StrategyEnv): number {
  return pnlAt(legs, S, firstExpiry(legs, env.now), env);
}

/** Net premium in currency: positive = credit received, negative = debit paid. */
export function netPremium(legs: readonly Leg[], multiplier: number): number {
  let v = 0;
  for (const l of legs) if (l.kind !== 'underlying') v -= l.qty * l.premium * multiplier;
  return v;
}

/** Position Greeks in currency (delta and gamma in underlying units × multiplier). */
export function strategyGreeks(
  legs: readonly Leg[],
  S: number,
  t: number,
  env: StrategyEnv,
): Greeks {
  const tot: Greeks = { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of legs) {
    const m = l.qty * env.multiplier;
    const basis = l.basis ?? 1;
    if (l.kind === 'underlying') {
      tot.price += m * S * basis;
      tot.delta += m * basis;
      continue;
    }
    const g = greeks({
      kind: l.kind,
      S: S * basis,
      K: l.strike,
      T: yearFrac(t, l.expiry),
      r: env.r,
      q: env.q,
      sigma: l.iv,
      model: env.model,
    });
    tot.price += m * g.price;
    tot.delta += m * g.delta * basis;
    tot.gamma += m * g.gamma * basis * basis;
    tot.theta += m * g.theta;
    tot.vega += m * g.vega;
    tot.rho += m * g.rho;
  }
  return tot;
}

/** Sign changes of fn on a sorted grid, refined by bisection to ~1e-12 relative. */
export function findRoots(fn: (x: number) => number, grid: readonly number[]): number[] {
  const roots: number[] = [];
  const push = (x: number) => {
    const last = roots[roots.length - 1];
    if (last === undefined || Math.abs(x - last) > 1e-9 * Math.max(1, Math.abs(x))) roots.push(x);
  };
  let x0 = grid[0]!;
  let f0 = fn(x0);
  if (f0 === 0) push(x0);
  for (let i = 1; i < grid.length; i++) {
    const x1 = grid[i]!;
    const f1 = fn(x1);
    if (f1 === 0) {
      push(x1);
    } else if (f0 !== 0 && Math.sign(f0) !== Math.sign(f1)) {
      let a = x0;
      let b = x1;
      let fa = f0;
      for (let k = 0; k < 200 && b - a > 1e-12 * Math.max(1, Math.abs(a)); k++) {
        const m = (a + b) / 2;
        const fm = fn(m);
        if (fm === 0) {
          a = b = m;
          break;
        }
        if (Math.sign(fm) === Math.sign(fa)) {
          a = m;
          fa = fm;
        } else b = m;
      }
      push((a + b) / 2);
    }
    x0 = x1;
    f0 = f1;
  }
  return roots;
}

export interface StrategyAnalysis {
  /** Earliest option expiry used as the "at expiry" horizon. */
  horizon: number;
  netPremium: number;
  /** +Infinity when profit is unlimited. */
  maxProfit: number;
  /** -Infinity when loss is unlimited. */
  maxLoss: number;
  breakevens: number[];
  /** Probability that P/L at the horizon is > 0 under a lognormal distribution. */
  pop: number;
  /** Greeks at valuation time `now`. */
  greeks: Greeks;
}

export interface AnalyzeOptions {
  /** Volatility for the probability distribution; default = mean IV of the option legs. */
  sigma?: number;
  /**
   * Drift of the underlying for probability of profit. Default: r − q for Black-Scholes,
   * 0 for Black-76 (futures are a martingale under the risk-neutral measure).
   */
  drift?: number;
}

/** Evaluation grid: 0, every strike, the spot and a dense band up to 3× the largest of them. */
function payoffGrid(legs: readonly Leg[], spot: number): { grid: number[]; hi: number } {
  const strikes = optionLegs(legs).map((l) => l.strike / (l.basis ?? 1));
  const top = Math.max(spot, ...strikes, 1e-9);
  const hi = top * 3;
  const pts = new Set<number>([0, ...strikes, spot, hi]);
  const n = 600;
  for (let i = 1; i < n; i++) pts.add((hi * i) / n);
  return { grid: [...pts].filter((x) => x >= 0).sort((a, b) => a - b), hi };
}

/**
 * Lognormal probability that fn(S_T) > 0 given the sorted roots of fn on (0, ∞).
 * ln S_T ~ N(ln S + (μ − σ²/2)τ, σ²τ).
 */
export function probabilityPositive(
  fn: (x: number) => number,
  roots: readonly number[],
  spot: number,
  sigma: number,
  tau: number,
  drift = 0,
): number {
  if (!(tau > 0) || !(sigma > 0) || !(spot > 0)) return fn(spot) > 0 ? 1 : 0;
  const m = Math.log(spot) + (drift - (sigma * sigma) / 2) * tau;
  const s = sigma * Math.sqrt(tau);
  const cdf = (x: number) => (x <= 0 ? 0 : x === Infinity ? 1 : normCdf((Math.log(x) - m) / s));
  const cuts = [0, ...roots.filter((r) => r > 0), Infinity];
  let p = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    const mid = b === Infinity ? Math.max(a * 2, spot * 2, 1) : a === 0 ? b / 2 : (a + b) / 2;
    if (fn(mid) > 0) p += cdf(b) - cdf(a);
  }
  return Math.min(1, Math.max(0, p));
}

/** Full analysis of a position: premium, max profit / loss, breakevens, PoP and Greeks. */
export function analyzeStrategy(
  legs: readonly Leg[],
  spot: number,
  env: StrategyEnv,
  opts: AnalyzeOptions = {},
): StrategyAnalysis {
  const horizon = firstExpiry(legs, env.now);
  const fn = (S: number) => pnlAt(legs, S, horizon, env);
  const { grid, hi } = payoffGrid(legs, spot);
  // Slope as S → ∞: calls and the underlying grow 1:1 (later-dated calls have delta → 1).
  let slope = 0;
  for (const l of legs) if (l.kind !== 'put') slope += l.qty * env.multiplier * (l.basis ?? 1);
  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (const x of grid) {
    const v = fn(x);
    if (v > maxProfit) maxProfit = v;
    if (v < maxLoss) maxLoss = v;
  }
  const far = fn(hi * 10);
  maxProfit = Math.max(maxProfit, far);
  maxLoss = Math.min(maxLoss, far);
  const eps = 1e-9 * Math.max(1, Math.abs(env.multiplier));
  if (slope > eps) maxProfit = Infinity;
  if (slope < -eps) maxLoss = -Infinity;
  const roots = findRoots(fn, [...grid, hi * 10]);
  const ivs = optionLegs(legs)
    .map((l) => l.iv)
    .filter((v) => v > 0);
  const sigma = opts.sigma ?? (ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0);
  const drift = opts.drift ?? (env.model === 'b76' ? 0 : env.r - (env.q ?? 0));
  const pop = probabilityPositive(fn, roots, spot, sigma, yearFrac(env.now, horizon), drift);
  return {
    horizon,
    netPremium: netPremium(legs, env.multiplier),
    maxProfit,
    maxLoss,
    breakevens: roots,
    pop,
    greeks: strategyGreeks(legs, spot, env.now, env),
  };
}

/**
 * Mark-to-market P/L of open legs. `markOf` returns the current price of a leg (e.g. the chain
 * mid); when it returns null the leg is valued with the model at its own IV.
 */
export function markPnl(
  legs: readonly Leg[],
  spot: number,
  env: StrategyEnv,
  markOf: (leg: Leg) => number | null = () => null,
): number {
  let v = 0;
  for (const l of legs) {
    const m = markOf(l) ?? legValue(l, spot, env.now, env);
    v += l.qty * env.multiplier * (m - l.premium);
  }
  return v;
}
