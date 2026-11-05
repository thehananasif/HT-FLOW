import { normCdf, normPdf } from './normal';

export type OptionKind = 'call' | 'put';

/**
 * `bs`  — Black-Scholes-Merton on a spot price with a continuous dividend / funding yield q
 *         (stocks, crypto spot and perpetuals).
 * `b76` — Black-76 on a futures / forward price (futures options, Deribit options on futures).
 */
export type PricingModel = 'bs' | 'b76';

export interface OptionParams {
  kind: OptionKind;
  /** Spot price (bs) or futures / forward price (b76). */
  S: number;
  K: number;
  /** Time to expiry in years (ACT/365). */
  T: number;
  /** Continuously compounded risk-free rate, decimal (0.05 = 5 %). */
  r: number;
  /** Volatility, decimal (0.25 = 25 %). */
  sigma: number;
  /** Continuous dividend / funding yield for `bs`, decimal. Ignored by `b76`. */
  q?: number;
  model?: PricingModel;
}

/**
 * Price and sensitivities per one unit of the underlying.
 * Conventions (as shown on the board): theta per calendar day, vega per 1 volatility point
 * (0.01), rho per 1 % change in the rate (0.01).
 */
export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Change in value per calendar day passing (annual theta / 365). */
  theta: number;
  /** Change in value for +1 vol point. */
  vega: number;
  /** Change in value for +1 % in r. */
  rho: number;
}

export const DAY_MS = 86_400_000;
export const YEAR_MS = 365 * DAY_MS;

/** Year fraction ACT/365 between two epoch-ms instants (never negative). */
export function yearFrac(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / YEAR_MS);
}

/** Cost of carry b: r − q for Black-Scholes, 0 for Black-76. */
export function costOfCarry(p: Pick<OptionParams, 'r' | 'q' | 'model'>): number {
  return (p.model ?? 'bs') === 'b76' ? 0 : p.r - (p.q ?? 0);
}

/** Forward price implied by the model inputs (F = S·e^{bT}). */
export function forwardOf(p: Pick<OptionParams, 'S' | 'T' | 'r' | 'q' | 'model'>): number {
  return p.S * Math.exp(costOfCarry(p) * p.T);
}

export function intrinsic(kind: OptionKind, S: number, K: number): number {
  return kind === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
}

const MIN_SIGMA = 1e-9;

/** Generalised Black-Scholes-Merton price (cost-of-carry form, Haug 2007 §1.1.6). */
export function optionPrice(p: OptionParams): number {
  if (!(p.T > 0)) return intrinsic(p.kind, p.S, p.K);
  if (!(p.S > 0)) {
    // Underlying at zero: a call is worthless, a put is worth the discounted strike.
    return p.kind === 'call' ? 0 : p.K * Math.exp(-p.r * p.T);
  }
  const b = costOfCarry(p);
  const sigma = Math.max(MIN_SIGMA, p.sigma);
  const sqT = Math.sqrt(p.T);
  const d1 = (Math.log(p.S / p.K) + (b + (sigma * sigma) / 2) * p.T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const cb = Math.exp((b - p.r) * p.T);
  const df = Math.exp(-p.r * p.T);
  return p.kind === 'call'
    ? p.S * cb * normCdf(d1) - p.K * df * normCdf(d2)
    : p.K * df * normCdf(-d2) - p.S * cb * normCdf(-d1);
}

/** Price and Greeks (see {@link Greeks} for units). */
export function greeks(p: OptionParams): Greeks {
  const model = p.model ?? 'bs';
  if (!(p.T > 0)) {
    const itm = p.kind === 'call' ? p.S > p.K : p.S < p.K;
    return {
      price: intrinsic(p.kind, p.S, p.K),
      delta: itm ? (p.kind === 'call' ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }
  const b = costOfCarry(p);
  const sigma = Math.max(MIN_SIGMA, p.sigma);
  const sqT = Math.sqrt(p.T);
  const S = Math.max(p.S, 1e-300);
  const d1 = (Math.log(S / p.K) + (b + (sigma * sigma) / 2) * p.T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const cb = Math.exp((b - p.r) * p.T);
  const df = Math.exp(-p.r * p.T);
  const nd1 = normPdf(d1);
  const call = p.kind === 'call';
  const price = call
    ? S * cb * normCdf(d1) - p.K * df * normCdf(d2)
    : p.K * df * normCdf(-d2) - S * cb * normCdf(-d1);
  const delta = call ? cb * normCdf(d1) : cb * (normCdf(d1) - 1);
  const gamma = (cb * nd1) / (S * sigma * sqT);
  const vega = S * cb * nd1 * sqT;
  const decay = (-S * cb * nd1 * sigma) / (2 * sqT);
  const thetaYear = call
    ? decay - (b - p.r) * S * cb * normCdf(d1) - p.r * p.K * df * normCdf(d2)
    : decay + (b - p.r) * S * cb * normCdf(-d1) + p.r * p.K * df * normCdf(-d2);
  // Black-76: the futures price does not move with r, only the discount factor does.
  const rhoYear =
    model === 'b76'
      ? -p.T * price
      : call
        ? p.T * p.K * df * normCdf(d2)
        : -p.T * p.K * df * normCdf(-d2);
  return {
    price,
    delta,
    gamma,
    theta: thetaYear / 365,
    vega: vega / 100,
    rho: rhoYear / 100,
  };
}
