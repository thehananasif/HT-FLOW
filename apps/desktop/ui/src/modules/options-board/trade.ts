import { isoExpiry, type Leg, type OptionsChain } from '@htflow/options';
import type { OptionTradeRequest } from '@htflow/trading';

/** Price the chain's payoff axis is drawn against (spot, or the nearest forward for Black-76). */
export const chainAxis = (c: Pick<OptionsChain, 'model' | 'spot' | 'expiries'>): number =>
  c.model === 'b76' ? (c.expiries[0]?.forward ?? c.spot) : c.spot;

/**
 * A strategy leg as a paper options trade (P18): premium at the leg's price, model inputs from
 * the chain (model, rate, yield, IV) and the expiry's forward / spot ratio, so the paper engine
 * marks the position the way the board priced it. Null for legs that are not options.
 */
export function legToTrade(
  leg: Leg,
  chain: Pick<OptionsChain, 'model' | 'spot' | 'expiries' | 'r' | 'q' | 'multiplier'>,
  accountId: string,
  underlyingId: string,
): OptionTradeRequest | null {
  if (leg.kind === 'underlying' || !(leg.qty !== 0) || !(leg.premium >= 0)) return null;
  const axis = chainAxis(chain);
  const basis = chain.spot > 0 ? ((leg.basis ?? 1) * axis) / chain.spot : (leg.basis ?? 1);
  return {
    accountId,
    underlyingId,
    right: leg.kind,
    strike: leg.strike,
    expiry: isoExpiry(leg.expiry),
    expiryTs: leg.expiry,
    side: leg.qty > 0 ? 'buy' : 'sell',
    qty: Math.abs(leg.qty),
    premium: leg.premium,
    multiplier: chain.multiplier,
    name: leg.name,
    iv: leg.iv,
    model: chain.model,
    r: chain.r,
    q: chain.q,
    basis,
  };
}
