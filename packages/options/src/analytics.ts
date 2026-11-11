/**
 * Options Analytics indicators (spec Appendix B) as pure functions: Options Board (strike / OI
 * levels), Options Position (payoff of open legs), Volatility Smile (per-expiry curve) and
 * Options Risk Profile (P&L across price and time). Chart layers can render these directly.
 */
import { midPrice, type ChainExpiry, type OptionsChain } from './chain';
import { DAY_MS } from './pricing';
import { analyzeStrategy, firstExpiry, pnlAt, type Leg, type StrategyEnv } from './strategy';

export interface PayoffCurve {
  prices: number[];
  /** P/L at the earliest expiry. */
  expiry: number[];
  /** P/L at the valuation time (default now). */
  now: number[];
  breakevens: number[];
  maxProfit: number;
  maxLoss: number;
}

export interface PriceRange {
  from: number;
  to: number;
  steps?: number;
}

function linspace(r: PriceRange): number[] {
  const n = Math.max(2, Math.round(r.steps ?? 160));
  return Array.from({ length: n }, (_, i) => r.from + ((r.to - r.from) * i) / (n - 1));
}

/** A price window that shows every strike and breakeven with margin. */
export function payoffRange(
  legs: readonly Leg[],
  spot: number,
  breakevens: readonly number[] = [],
): PriceRange {
  const pts = [
    spot,
    ...breakevens,
    ...legs.filter((l) => l.kind !== 'underlying').map((l) => l.strike),
  ];
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const pad = Math.max((hi - lo) * 0.35, spot * 0.06);
  return { from: Math.max(0, lo - pad), to: hi + pad };
}

/** Options Position: payoff of the open legs at expiry and at a valuation date (T+n). */
export function optionsPositionPayoff(
  legs: readonly Leg[],
  spot: number,
  env: StrategyEnv,
  opts: { range?: PriceRange; at?: number } = {},
): PayoffCurve {
  const a = analyzeStrategy(legs, spot, env);
  const range = opts.range ?? payoffRange(legs, spot, a.breakevens);
  const prices = linspace(range);
  const horizon = firstExpiry(legs, env.now);
  const at = Math.min(opts.at ?? env.now, horizon);
  return {
    prices,
    expiry: prices.map((p) => pnlAt(legs, p, horizon, env)),
    now: prices.map((p) => pnlAt(legs, p, at, env)),
    breakevens: a.breakevens,
    maxProfit: a.maxProfit,
    maxLoss: a.maxLoss,
  };
}

export interface RiskProfile {
  prices: number[];
  /** Valuation times, epoch ms, from now to the earliest expiry. */
  times: number[];
  /** pnl[timeIndex][priceIndex]. */
  pnl: number[][];
}

/** Options Risk Profile: P&L across price and time. */
export function optionsRiskProfile(
  legs: readonly Leg[],
  spot: number,
  env: StrategyEnv,
  opts: { range?: PriceRange; timeSteps?: number; times?: number[] } = {},
): RiskProfile {
  const prices = linspace(opts.range ?? payoffRange(legs, spot));
  const horizon = firstExpiry(legs, env.now);
  const n = Math.max(2, opts.timeSteps ?? 5);
  const times =
    opts.times ??
    Array.from({ length: n }, (_, i) => env.now + ((horizon - env.now) * i) / (n - 1));
  return { prices, times, pnl: times.map((t) => prices.map((p) => pnlAt(legs, p, t, env))) };
}

export interface SmilePoint {
  strike: number;
  /** ln(K / F). */
  moneyness: number;
  callIv: number | null;
  putIv: number | null;
  /** Out-of-the-money side (puts below the forward, calls above). */
  iv: number | null;
}

export interface SmileCurve {
  expiry: number;
  days: number;
  forward: number;
  points: SmilePoint[];
}

const sideIv = (q?: { bidIv: number | null; askIv: number | null; markIv: number | null }) => {
  if (!q) return null;
  if (q.bidIv !== null && q.askIv !== null) return (q.bidIv + q.askIv) / 2;
  return q.markIv ?? q.askIv ?? q.bidIv;
};

/** Volatility Smile of one expiry. */
export function volatilitySmile(e: ChainExpiry, now: number): SmileCurve {
  return {
    expiry: e.expiry,
    days: Math.max(0, (e.expiry - now) / DAY_MS),
    forward: e.forward,
    points: e.strikes.map((s) => {
      const callIv = sideIv(s.call?.quote);
      const putIv = sideIv(s.put?.quote);
      return {
        strike: s.strike,
        moneyness: Math.log(s.strike / e.forward),
        callIv,
        putIv,
        iv: s.strike < e.forward ? (putIv ?? callIv) : (callIv ?? putIv),
      };
    }),
  };
}

/** Volatility Smile: one curve per expiry. */
export function volatilitySmiles(chain: OptionsChain, now: number = chain.updatedAt): SmileCurve[] {
  return chain.expiries.map((e) => volatilitySmile(e, now));
}

export interface StrikeLevel {
  strike: number;
  callOi: number;
  putOi: number;
  totalOi: number;
  callVolume: number;
  putVolume: number;
}

/** Options Board indicator: open interest / volume per strike (on-chart levels), all or selected expiries. */
export function strikeLevels(chain: OptionsChain, expiries?: readonly number[]): StrikeLevel[] {
  const m = new Map<number, StrikeLevel>();
  for (const e of chain.expiries) {
    if (expiries && !expiries.includes(e.expiry)) continue;
    for (const s of e.strikes) {
      const l = m.get(s.strike) ?? {
        strike: s.strike,
        callOi: 0,
        putOi: 0,
        totalOi: 0,
        callVolume: 0,
        putVolume: 0,
      };
      l.callOi += s.call?.quote.openInterest ?? 0;
      l.putOi += s.put?.quote.openInterest ?? 0;
      l.callVolume += s.call?.quote.volume ?? 0;
      l.putVolume += s.put?.quote.volume ?? 0;
      l.totalOi = l.callOi + l.putOi;
      m.set(s.strike, l);
    }
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

/** Strike at which option holders lose the most at expiry (max pain) for one expiry. */
export function maxPain(e: ChainExpiry): number | null {
  let best: number | null = null;
  let bestPay = Infinity;
  for (const s of e.strikes) {
    let pay = 0;
    for (const o of e.strikes) {
      pay += (o.call?.quote.openInterest ?? 0) * Math.max(0, s.strike - o.strike);
      pay += (o.put?.quote.openInterest ?? 0) * Math.max(0, o.strike - s.strike);
    }
    if (pay < bestPay) {
      bestPay = pay;
      best = s.strike;
    }
  }
  return best;
}

/** Current price of a named leg from the chain (mid, else mark), for mark-to-market. */
export function chainMark(chain: OptionsChain, name: string | undefined): number | null {
  if (!name) return null;
  for (const e of chain.expiries)
    for (const s of e.strikes) {
      const c = s.call?.name === name ? s.call : s.put?.name === name ? s.put : undefined;
      if (c) return midPrice(c.quote);
    }
  return null;
}
