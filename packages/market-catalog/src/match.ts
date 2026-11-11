import type { CatalogInstrument } from './types';
import type { Catalog } from './catalog';
import { parseContractCode } from './expiry';

/** The fields of a feed instrument (any connector) needed to find its catalog entry. */
export interface FeedInstrumentLike {
  id: string;
  symbol: string;
  exchange: string;
  assetClass: string;
  displayName?: string;
}

const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "BTC-USDT-SWAP" / "PF_XBTUSD" / "BTCUSDT" → "BTCUSDT" / "XBTUSD" (venue decorations removed). */
export function normalizeCryptoSymbol(s: string): string {
  return compact(s.replace(/^PF_/, '').replace(/[-_](SWAP|PERP|PERPETUAL)$/i, '')).replace(
    /PERP(ETUAL)?$/,
    '',
  );
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
  for (const c of cat.instruments) {
    for (const p of c.providers) {
      const fid = p.provider === 'sim' ? p.symbol : `${p.provider}:${p.symbol}`;
      if (fid === bare) return c;
    }
  }
  if (inst.assetClass === 'crypto') {
    const sym = normalizeCryptoSymbol(inst.symbol);
    const hay = `${inst.exchange} ${providerLabel} ${inst.id.split(':')[0]}`.toLowerCase();
    const spot = /spot/.test(hay);
    const candidates = cat.instruments.filter(
      (c) =>
        c.assetClass === 'crypto' &&
        normalizeCryptoSymbol(c.symbol) === sym &&
        hay.includes(c.exchange.split(' ')[0]!.toLowerCase()),
    );
    return candidates.find((c) => /spot/i.test(c.subGroup) === spot) ?? candidates[0] ?? undefined;
  }
  if (inst.assetClass === 'future') {
    const p = parseContractCode(inst.symbol);
    const root = p?.root ?? inst.symbol;
    return cat.byRoot(root, inst.exchange) ?? cat.byRoot(root);
  }
  return undefined;
}
