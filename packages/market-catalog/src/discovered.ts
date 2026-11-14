import type { CatalogInstrument, ProviderMapping } from './types';
import { catalogId, decimals, SESSIONS } from './seed/common';
import { COIN_NAMES } from './seed/crypto';

/**
 * Live symbol discovery (P04/P05): one row per tradable instrument, as the desktop core reads it
 * from each venue's public exchange-info endpoint (`instruments_list`). The web preview cannot
 * call those endpoints (no CORS) and keeps the built-in seed list.
 */
export interface DiscoveredInstrument {
  /** Feed provider id it streams through (`binance-futures`, `okx-swap`, …) or a catalog-only key. */
  venue: string;
  market: 'perp' | 'future' | 'spot';
  symbol: string;
  base: string;
  quote: string;
  settle: string;
  inverse: boolean;
  tickSize: number;
  pricePrecision: number;
  lotStep: number;
  qtyPrecision: number;
  minQty: number;
  contractSize: number;
  expiryMs?: number;
}

/** Result of one discovery source (see src-tauri/instruments_cmds.rs). */
export interface DiscoverySource {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  fetchedAtMs: number;
  count: number;
  optionsCount?: number;
  instruments: DiscoveredInstrument[];
}

export interface DiscoveryReport {
  refreshedAtMs: number;
  stale: boolean;
  sources: DiscoverySource[];
}

/** How a discovered venue + market shows in the catalog. */
interface Family {
  /** Seed provider key the curated entries of this family use (for the override match). */
  seed: string;
  exchange: string;
  subGroup: string;
  spot: boolean;
}

/** Feed providers the Rust connectors stream (anything else is listed with "No feed"). */
export const STREAMING_VENUES = new Set([
  'binance-futures',
  'binance-coinm',
  'binance-spot',
  'bybit-linear',
  'okx-swap',
  'whitebit',
  'phemex',
  'bitfinex',
  'kraken-futures',
  'deribit',
  'bitget',
]);

export function familyOf(d: Pick<DiscoveredInstrument, 'venue' | 'market'>): Family {
  const f = (seed: string, exchange: string, subGroup: string, spot = false): Family => ({
    seed,
    exchange,
    subGroup,
    spot,
  });
  switch (d.venue) {
    case 'binance-futures':
    case 'binance-coinm':
      return f(d.venue, 'Binance Futures', 'Binance Futures (USDⓈ-M + COIN-M)');
    case 'binance-spot':
      return f('binance-spot', 'Binance', 'Binance (spot)', true);
    case 'bybit-linear':
      return f('bybit-linear', 'Bybit', 'Bybit Futures');
    case 'bybit-inverse':
      return f('bybit-inverse', 'Bybit', 'Bybit Inverse');
    case 'bybit-spot':
      return f('bybit-spot', 'Bybit', 'Bybit Spot', true);
    case 'okx-swap':
      if (d.market === 'spot') return f('okx-spot', 'OKX', 'OKX Spot', true);
      if (d.market === 'future') return f('okx-futures', 'OKX', 'OKX Futures');
      return f('okx-swap', 'OKX', 'OKX Perpetual Futures');
    case 'kraken-futures':
      return f(
        'kraken-futures',
        'Kraken Futures',
        d.market === 'future' ? 'Kraken Futures (dated)' : 'Kraken Flexible Perpetual Futures',
      );
    case 'phemex':
      return f('phemex-futures', 'Phemex', 'Phemex Hedged Futures');
    case 'whitebit':
      return d.market === 'spot'
        ? f('whitebit-spot', 'WhiteBIT', 'WhiteBIT Spot', true)
        : f('whitebit-futures', 'WhiteBIT', 'WhiteBIT Futures');
    case 'bitget':
      return f('bitget-futures', 'Bitget', 'Bitget Futures');
    case 'bitfinex':
      return f('bitfinex', 'Bitfinex', 'Bitfinex');
    case 'deribit':
      return f('deribit', 'Deribit', 'Deribit (options & futures)');
    default:
      return f(d.venue, d.venue, d.venue, d.market === 'spot');
  }
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

function kindLabel(d: DiscoveredInstrument): string {
  if (d.market === 'spot') return 'Spot';
  if (d.market === 'future') {
    const e = d.expiryMs ? new Date(d.expiryMs) : null;
    const when = e ? ` ${e.getUTCDate()} ${MONTHS[e.getUTCMonth()]} ${e.getUTCFullYear()}` : '';
    return `${d.inverse ? 'Inverse futures' : 'Futures'}${when}`;
  }
  return d.inverse ? 'Inverse perpetual' : 'Perpetual';
}

/** Display suffix for feed instruments ("Perpetual", "Spot", "Futures 26 Dec 2026"). */
export const discoveredSuffix = kindLabel;

/** Quote currency prices are in (USD for inverse contracts). */
export const discoveredCurrency = (d: DiscoveredInstrument) => d.quote || d.settle || 'USD';

/** A catalog entry for a discovered instrument (no curated seed entry). */
export function discoveredToCatalog(d: DiscoveredInstrument): CatalogInstrument {
  const fam = familyOf(d);
  const coin = COIN_NAMES[d.base] ?? d.base;
  const tickSize = d.tickSize;
  const lot = d.lotStep > 0 ? d.lotStep : 1;
  const providers: ProviderMapping[] = [{ provider: d.venue, symbol: d.symbol }];
  const quote = discoveredCurrency(d);
  return {
    id: catalogId(fam.exchange + (fam.spot ? '-SPOT' : ''), d.symbol),
    symbol: d.symbol,
    name: `${coin} ${kindLabel(d)}`,
    root: d.base,
    exchange: fam.exchange,
    assetClass: 'crypto',
    group: 'Crypto',
    subGroup: fam.subGroup,
    currency: quote,
    tickSize,
    tickValue: 0,
    pointValue: 0,
    multiplier: d.contractSize > 0 ? d.contractSize : 1,
    unit: d.inverse ? quote : d.base,
    pricePrecision: Number.isFinite(d.pricePrecision) ? d.pricePrecision : decimals(tickSize),
    lotStep: lot,
    minQty: d.minQty > 0 ? d.minQty : lot,
    sessions: SESSIONS.crypto,
    holidayCalendar: 'NONE',
    providers,
    options: d.venue === 'deribit',
    spec_source_url: '',
    verified: true,
    aliases: [d.base, `${d.base}/${quote}`, coin, fam.subGroup, d.settle].filter(Boolean),
    note: d.expiryMs ? `Expires ${new Date(d.expiryMs).toISOString().slice(0, 10)}` : undefined,
  };
}

/**
 * Merges discovered instruments into the seed catalog.
 * - A curated seed entry of the same family and symbol keeps its id, name, sessions and aliases;
 *   the live specs (tick, precision, lot, min qty, contract size) replace its placeholders and its
 *   provider mapping points at the real feed.
 * - Unmatched seed crypto placeholders of a family the discovery covered are dropped (the venue
 *   does not list them).
 * - Everything else is added. Ids stay unique (first wins).
 */
export function mergeDiscovered(
  seed: readonly CatalogInstrument[],
  discovered: readonly DiscoveredInstrument[],
): CatalogInstrument[] {
  if (!discovered.length) return [...seed];
  const seedByKey = new Map<string, CatalogInstrument>();
  for (const c of seed)
    if (c.assetClass === 'crypto')
      for (const p of c.providers) seedByKey.set(`${p.provider}:${p.symbol}`, c);
  const covered = new Set<string>();
  const overrides = new Map<string, CatalogInstrument>();
  const added: CatalogInstrument[] = [];
  const ids = new Set(seed.map((c) => c.id));
  for (const d of discovered) {
    if (!(d.tickSize > 0) || !d.symbol) continue;
    const fam = familyOf(d);
    covered.add(fam.seed);
    const s = seedByKey.get(`${fam.seed}:${d.symbol}`) ?? seedByKey.get(`${d.venue}:${d.symbol}`);
    const live = discoveredToCatalog(d);
    if (s && !overrides.has(s.id)) {
      overrides.set(s.id, {
        ...s,
        currency: live.currency,
        tickSize: live.tickSize,
        pricePrecision: live.pricePrecision,
        lotStep: live.lotStep,
        minQty: live.minQty,
        multiplier: live.multiplier,
        verified: true,
        providers: [
          { provider: d.venue, symbol: d.symbol },
          ...s.providers.filter((p) => p.provider !== fam.seed && p.provider !== d.venue),
        ],
        note: live.note ?? s.note,
      });
      continue;
    }
    if (ids.has(live.id)) continue;
    ids.add(live.id);
    added.push(live);
  }
  const out: CatalogInstrument[] = [];
  for (const c of seed) {
    const o = overrides.get(c.id);
    if (o) out.push(o);
    else if (
      c.assetClass === 'crypto' &&
      !c.verified &&
      c.providers.some((p) => covered.has(p.provider))
    )
      continue;
    else out.push(c);
  }
  return [...out, ...added];
}

/** Every instrument of a report, flattened (sources in report order). */
export function reportInstruments(r: DiscoveryReport | null | undefined): DiscoveredInstrument[] {
  return r ? r.sources.flatMap((s) => s.instruments) : [];
}
