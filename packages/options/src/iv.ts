import { normCdf, normPdf } from './normal';
import { costOfCarry, type OptionParams } from './pricing';

export interface ImpliedVolInput extends Omit<OptionParams, 'sigma'> {
  /** Observed option price (same units as S and K). */
  price: number;
}

export interface ImpliedVolOptions {
  /** Lower / upper volatility bounds (decimal). Defaults 1e-6 and 10 (1000 %). */
  lo?: number;
  hi?: number;
  /** Stop when the volatility bracket or Newton step is below this. Default 1e-10. */
  tol?: number;
  maxIter?: number;
}

/** Undiscounted Black price and vega on forward F (the problem the solver works in). */
function black(kind: 'call' | 'put', F: number, K: number, T: number, sigma: number) {
  const sqT = Math.sqrt(T);
  const sd = sigma * sqT;
  const d1 = (Math.log(F / K) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  const price =
    kind === 'call' ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
  return { price, vega: F * normPdf(d1) * sqT };
}

/**
 * Implied volatility for Black-Scholes (q) or Black-76 prices.
 *
 * The price is moved to forward space and, through put-call parity, onto the out-of-the-money
 * option, which keeps deep in-the-money quotes well conditioned. Newton–Raphson steps run inside a
 * bisection bracket: whenever a step leaves the bracket or vega is too small, the solver bisects,
 * so it always converges when a solution exists. Returns NaN when the price is outside the
 * no-arbitrage bounds (below intrinsic, above the forward/strike bound) or T ≤ 0.
 */
export function impliedVol(input: ImpliedVolInput, opts: ImpliedVolOptions = {}): number {
  const { kind, S, K, T, r, price } = input;
  if (!(T > 0) || !(S > 0) || !(K > 0) || !Number.isFinite(price) || price < 0) return Number.NaN;
  const b = costOfCarry(input);
  const df = Math.exp(-r * T);
  const F = S * Math.exp(b * T);
  let target = price / df;
  let k: 'call' | 'put' = kind;
  // Move to the OTM side: c − p = F − K (undiscounted).
  if (kind === 'call' && F > K) {
    target -= F - K;
    k = 'put';
  } else if (kind === 'put' && K > F) {
    target -= K - F;
    k = 'call';
  }
  const upper = k === 'call' ? F : K;
  const eps = 1e-14 * Math.max(F, K);
  if (!(target > eps) || target >= upper) return Number.NaN;

  let lo = opts.lo ?? 1e-6;
  let hi = opts.hi ?? 10;
  const tol = opts.tol ?? 1e-10;
  const maxIter = opts.maxIter ?? 200;
  if (black(k, F, K, T, hi).price < target) return Number.NaN;
  if (black(k, F, K, T, lo).price > target) return lo;

  // Initial guess: Brenner–Subrahmanyam near the money, widened by the moneyness term.
  const x = Math.log(F / K);
  let sigma = Math.sqrt((2 * Math.PI) / T) * (target / Math.sqrt(F * K));
  sigma = Math.max(sigma, Math.sqrt((2 * Math.abs(x)) / T));
  if (!(sigma > lo && sigma < hi)) sigma = Math.min(hi, Math.max(lo, 0.3));

  for (let i = 0; i < maxIter; i++) {
    const { price: p, vega } = black(k, F, K, T, sigma);
    const diff = p - target;
    if (diff === 0) return sigma;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    let next = vega > 1e-300 ? sigma - diff / vega : Number.NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - sigma) < tol * Math.max(1, sigma) || hi - lo < tol) return next;
    sigma = next;
  }
  return sigma;
}
