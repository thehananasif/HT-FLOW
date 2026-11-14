import type { CatalogInstrument, ProviderMapping } from '../types';
import { catalogId, decimals, SESSIONS } from './common';

/**
 * Appendix A section 2 — crypto venues (free, built in).
 *
 * Curated seed: the same majors on every venue (`verified: false` placeholders). The desktop app
 * replaces them with every tradable instrument of every venue, read live from each venue's
 * exchange-info endpoint by its connector (see ../discovered.ts, src-tauri/instruments_cmds.rs):
 * matching seed entries keep their names and sessions, the live specs override. The web preview
 * cannot reach those endpoints (no CORS) and shows this seed list.
 */
interface Venue {
  sub: string;
  exchange: string;
  /** Provider key used for feed ids (`${provider}:${symbol}`). */
  provider: string;
  kind: 'perp' | 'spot' | 'future' | 'inverse';
  symbol: (base: string) => string;
  url: string;
  options?: boolean;
}

const VENUES: Venue[] = [
  {
    sub: 'Binance (spot)',
    exchange: 'Binance',
    provider: 'binance-spot',
    kind: 'spot',
    symbol: (b) => `${b}USDT`,
    url: 'https://www.binance.com/en/trade-rule',
  },
  {
    sub: 'Binance Futures (USDⓈ-M + COIN-M)',
    exchange: 'Binance Futures',
    provider: 'binance-futures',
    kind: 'perp',
    symbol: (b) => `${b}USDT`,
    url: 'https://www.binance.com/en/futures/trading-rules/perpetual',
  },
  {
    sub: 'Binance Futures (USDⓈ-M + COIN-M)',
    exchange: 'Binance Futures',
    provider: 'binance-coinm',
    kind: 'inverse',
    symbol: (b) => `${b}USD_PERP`,
    url: 'https://www.binance.com/en/futures/trading-rules/perpetual',
  },
  {
    sub: 'Bitget Futures',
    exchange: 'Bitget',
    provider: 'bitget-futures',
    kind: 'perp',
    symbol: (b) => `${b}USDT`,
    url: 'https://www.bitget.com/futures/introduction/symbol',
  },
  {
    sub: 'Bybit Futures',
    exchange: 'Bybit',
    provider: 'bybit-linear',
    kind: 'perp',
    symbol: (b) => `${b}USDT`,
    url: 'https://www.bybit.com/en/announcement-info/transact-parameters',
  },
  {
    sub: 'Bybit Spot',
    exchange: 'Bybit',
    provider: 'bybit-spot',
    kind: 'spot',
    symbol: (b) => `${b}USDT`,
    url: 'https://www.bybit.com/en/announcement-info/spot-trading-rules',
  },
  {
    sub: 'Kraken Flexible Perpetual Futures',
    exchange: 'Kraken Futures',
    provider: 'kraken-futures',
    kind: 'perp',
    symbol: (b) => `PF_${b === 'BTC' ? 'XBT' : b}USD`,
    url: 'https://support.kraken.com/hc/en-us/sections/360012894412-Futures-Trading',
  },
  {
    sub: 'Kraken Spot',
    exchange: 'Kraken',
    provider: 'kraken-spot',
    kind: 'spot',
    symbol: (b) => `${b === 'BTC' ? 'XBT' : b}/USD`,
    url: 'https://support.kraken.com/hc/en-us/articles/360000767986',
  },
  {
    sub: 'OKX Futures',
    exchange: 'OKX',
    provider: 'okx-futures',
    kind: 'future',
    symbol: (b) => `${b}-USD-QUARTER`,
    url: 'https://www.okx.com/trade-market/info/futures',
  },
  {
    sub: 'OKX Perpetual Futures',
    exchange: 'OKX',
    provider: 'okx-swap',
    kind: 'perp',
    symbol: (b) => `${b}-USDT-SWAP`,
    url: 'https://www.okx.com/trade-market/info/swap',
  },
  {
    sub: 'OKX Spot',
    exchange: 'OKX',
    provider: 'okx-spot',
    kind: 'spot',
    symbol: (b) => `${b}-USDT`,
    url: 'https://www.okx.com/trade-market/info/spot',
  },
  {
    sub: 'Phemex Hedged Futures',
    exchange: 'Phemex',
    provider: 'phemex-futures',
    kind: 'perp',
    symbol: (b) => `${b}USDT`,
    url: 'https://phemex.com/contract-specifications',
  },
  {
    sub: 'Phemex Spot',
    exchange: 'Phemex',
    provider: 'phemex-spot',
    kind: 'spot',
    symbol: (b) => `s${b}USDT`,
    url: 'https://phemex.com/spot-specifications',
  },
  {
    sub: 'WhiteBIT Futures',
    exchange: 'WhiteBIT',
    provider: 'whitebit-futures',
    kind: 'perp',
    symbol: (b) => `${b}_PERP`,
    url: 'https://whitebit.com/fees',
  },
  {
    sub: 'WhiteBIT Spot',
    exchange: 'WhiteBIT',
    provider: 'whitebit-spot',
    kind: 'spot',
    symbol: (b) => `${b}_USDT`,
    url: 'https://whitebit.com/fees',
  },
  {
    sub: 'Bitfinex',
    exchange: 'Bitfinex',
    provider: 'bitfinex',
    kind: 'spot',
    symbol: (b) => `t${b}USD`,
    url: 'https://www.bitfinex.com/fees',
  },
  {
    sub: 'Deribit (options & futures)',
    exchange: 'Deribit',
    provider: 'deribit',
    kind: 'perp',
    symbol: (b) => `${b}-PERPETUAL`,
    url: 'https://www.deribit.com/kb/futures',
    options: true,
  },
];

/** [base, name, typical tick in USD(T), qty step] — placeholders until exchange-info loads. */
const MAJORS: [string, string, number, number][] = [
  ['BTC', 'Bitcoin', 0.1, 0.001],
  ['ETH', 'Ether', 0.01, 0.001],
  ['SOL', 'Solana', 0.01, 1],
  ['XRP', 'XRP', 0.0001, 0.1],
  ['BNB', 'BNB', 0.01, 0.01],
  ['DOGE', 'Dogecoin', 0.00001, 1],
  ['ADA', 'Cardano', 0.0001, 1],
  ['AVAX', 'Avalanche', 0.001, 1],
  ['LINK', 'Chainlink', 0.001, 0.1],
  ['TON', 'Toncoin', 0.0001, 0.1],
];

/** Display names of well-known bases (discovered instruments use the base otherwise). */
export const COIN_NAMES: Record<string, string> = {
  ...Object.fromEntries(MAJORS.map(([b, n]) => [b, n])),
  XBT: 'Bitcoin',
  LTC: 'Litecoin',
  DOT: 'Polkadot',
  TRX: 'TRON',
  BCH: 'Bitcoin Cash',
  SHIB: 'Shiba Inu',
  PEPE: 'Pepe',
  SUI: 'Sui',
  NEAR: 'NEAR Protocol',
  UNI: 'Uniswap',
  AAVE: 'Aave',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  APT: 'Aptos',
  ATOM: 'Cosmos',
  FIL: 'Filecoin',
  ETC: 'Ethereum Classic',
  XLM: 'Stellar',
  HBAR: 'Hedera',
  POL: 'Polygon',
};

/** Venues that list each base: Deribit only BTC/ETH (+SOL perp), Binance COIN-M majors. */
function listed(v: Venue, base: string): boolean {
  if (v.provider === 'deribit') return base === 'BTC' || base === 'ETH';
  if (v.kind === 'inverse' || v.kind === 'future')
    return ['BTC', 'ETH', 'SOL', 'XRP'].includes(base);
  if (base === 'BNB') return v.exchange.startsWith('Binance') || v.exchange === 'Bybit';
  return true;
}

/** Binance USDⓈ-M symbols already streamed by the built-in Rust connector (desktop). */
const BINANCE_LIVE: Record<string, [number, number]> = {
  BTCUSDT: [0.1, 3],
  ETHUSDT: [0.01, 3],
  SOLUSDT: [0.01, 0],
  BNBUSDT: [0.01, 2],
  XRPUSDT: [0.0001, 1],
  DOGEUSDT: [0.00001, 0],
};

const KIND_LABEL: Record<Venue['kind'], string> = {
  perp: 'Perpetual',
  spot: 'Spot',
  future: 'Quarterly futures',
  inverse: 'Inverse perpetual',
};

export const CRYPTO: CatalogInstrument[] = VENUES.flatMap((v) =>
  MAJORS.filter(([base]) => listed(v, base)).map(([base, name, tick, step]) => {
    const symbol = v.symbol(base);
    const live = v.provider === 'binance-futures' ? BINANCE_LIVE[symbol] : undefined;
    const tickSize = live?.[0] ?? (v.kind === 'inverse' ? Math.max(tick, 0.1) : tick);
    const lot = live ? 10 ** -live[1] : step;
    const providers: ProviderMapping[] = [{ provider: v.provider, symbol }];
    // The built-in simulator plays BTCUSDT perpetual flow (Sim, clearly labelled).
    if (v.provider === 'binance-futures' && base === 'BTC')
      providers.push({ provider: 'sim', symbol: 'mock:BTCUSDT' });
    const quote =
      v.kind === 'inverse' || v.kind === 'future' || /USD$/.test(symbol) ? 'USD' : 'USDT';
    return {
      id: catalogId(v.exchange + (v.kind === 'spot' ? '-SPOT' : ''), symbol),
      symbol,
      name: `${name} ${KIND_LABEL[v.kind]}`,
      root: base,
      exchange: v.exchange,
      assetClass: 'crypto',
      group: 'Crypto',
      subGroup: v.sub,
      currency: quote,
      tickSize,
      tickValue: 0,
      pointValue: 0,
      multiplier: 1,
      unit: base,
      pricePrecision: decimals(tickSize),
      lotStep: lot,
      minQty: lot,
      sessions: SESSIONS.crypto,
      holidayCalendar: 'NONE',
      contract:
        v.kind === 'future'
          ? {
              cycle: 'HMUZ',
              expiry: { kind: 'lastWeekday', weekday: 5 },
              roll: { kind: 'date', daysBefore: 3 },
              backAdjust: false,
              listed: 3,
            }
          : undefined,
      providers,
      options: v.options ?? false,
      spec_source_url: v.url,
      verified: false,
      aliases: [base, `${base}/${quote}`, name, v.sub],
    } satisfies CatalogInstrument;
  }),
);
