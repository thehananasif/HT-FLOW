import type { CatalogInstrument } from './types';
import type { Catalog } from './catalog';
import { parseContractCode } from './expiry';
import { normalizeCryptoSymbol } from './normalize';

export { normalizeCryptoSymbol };

/** The fields of a feed instrument (any connector) needed to find its catalog entry. */
export interface FeedInstrumentLike {
  id: string;
  symbol: string;
  exchange: string;
  assetClass: string;
  displayName?: string;
}

/**
 * Finds the catalog entry a feed instrument belongs to:
 * 1. explicit provider mapping (`${provider}:${symbol}` equals the feed id, or `sim` full id);
 * 2. crypto: same normalised symbol on a venue whose name appears in the feed's exchange / label;
 * 3. futures: contract code ("CLZ6") or root on the same exchange.
 * `providerLabel` is the feed provider's picker label (e.g. "Bybit (live)").
 */
export function matchFeedInstrument(
  cat: Catalog,
  inst: FeedInstrumentLike,
  providerLabel = '',
): CatalogInstrument | undefined {
  const bare = inst.id.replace(/^replay:/, '');
  const exact = cat.byFeedId(bare);
  if (exact) return exact;
  if (inst.assetClass === 'crypto') {
    const sym = normalizeCryptoSymbol(inst.symbol);
    const hay = `${inst.exchange} ${providerLabel} ${inst.id.split(':')[0]}`.toLowerCase();
    const spot = /spot/.test(hay);
    const candidates = cat
      .cryptoBySymbol(sym)
      .filter((c) => hay.includes(c.exchange.split(' ')[0]!.toLowerCase()));
    return candidates.find((c) => /spot/i.test(c.subGroup) === spot) ?? candidates[0] ?? undefined;
  }
  if (inst.assetClass === 'future') {
    const p = parseContractCode(inst.symbol);
    const root = p?.root ?? inst.symbol;
    return cat.byRoot(root, inst.exchange) ?? cat.byRoot(root);
  }
  return undefined;
}
