import { intrinsic, optionPrice, yearFrac, type PricingModel } from './pricing';
import type { Leg } from './strategy';

/**
 * The fields of a paper-engine options position this package needs (structural, so
 * `@htflow/options` does not depend on `@htflow/trading`).
 */
export interface PaperOptionLike {
  id?: string;
  right: 'call' | 'put';
  /** Strike in price units. */
  strike: number;
  /** Expiry date YYYY-MM-DD (used when `expiryTs` is missing: 08:00 UTC that day). */
  expiry: string;
  expiryTs?: number;
  iv?: number;
  model?: PricingModel;
  r?: number;
  q?: number;
  /** Forward / spot ratio of the expiry (Black-76). */
  basis?: number;
  name?: string;
}

/** Default volatility when a position carries none (decimal). */
export const PAPER_DEFAULT_IV = 0.5;

/** Expiry instant of a paper option (epoch ms). */
export function paperOptionExpiry(p: Pick<PaperOptionLike, 'expiry' | 'expiryTs'>): number {
  return p.expiryTs ?? Date.parse(`${p.expiry}T08:00:00Z`);
}

/** ISO date (UTC) of an expiry instant, the paper engine's position key. */
export function isoExpiry(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Mark-to-model premium per unit (P18): Black-Scholes on spot, or Black-76 on spot × basis, with
 * the position's IV and rate; intrinsic value once expired. Undefined without a usable spot.
 */
export function paperOptionMark(
  p: PaperOptionLike,
  spot: number | undefined,
  now: number,
): number | undefined {
  if (spot === undefined || !Number.isFinite(spot) || spot <= 0) return undefined;
  const S = spot * (p.basis && p.basis > 0 ? p.basis : 1);
  const exp = paperOptionExpiry(p);
  if (!Number.isFinite(exp) || now >= exp) return intrinsic(p.right, S, p.strike);
  const v = optionPrice({
    kind: p.right,
    S,
    K: p.strike,
    T: yearFrac(now, exp),
    r: p.r ?? 0,
    q: p.q ?? 0,
    sigma: p.iv && p.iv > 0 ? p.iv : PAPER_DEFAULT_IV,
    model: p.model ?? 'bs',
  });
  return Number.isFinite(v) ? Math.max(0, v) : undefined;
}

/**
 * A paper options position as a strategy leg (Options Strategy Analyser payoff / P&L). `axis`
 * is the price the analyser's axis is drawn against (spot, or the nearest forward for Black-76),
 * so the leg's basis is re-expressed relative to it.
 */
export function paperOptionLeg(
  p: PaperOptionLike & { qty: number; avgPremium: number },
  spot?: number,
  axis?: number,
): Leg {
  const basis = p.basis && p.basis > 0 ? p.basis : 1;
  const rel = spot && axis && spot > 0 && axis > 0 ? (basis * spot) / axis : basis;
  return {
    id: p.id ?? `${p.right}-${p.strike}-${p.expiry}`,
    kind: p.right,
    strike: p.strike,
    expiry: paperOptionExpiry(p),
    qty: p.qty,
    premium: p.avgPremium,
    iv: p.iv && p.iv > 0 ? p.iv : PAPER_DEFAULT_IV,
    name: p.name,
    basis: rel,
  };
}
