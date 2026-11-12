/** Provider catalog of the Add-connection wizard (P32) — exactly the groups of the spec. */

export type ProviderGroup =
  'US and EU markets' | 'Prop connections' | 'Crypto' | 'Simulator' | 'Other';
export type ProviderTag = 'FREE' | 'YOUR ACCOUNT';
export type Capability =
  'Trades' | 'L2 depth' | 'MBO' | 'Funding' | 'Liquidations' | 'OI' | 'Trading';
export type FormKind = 'crypto' | 'broker' | 'simulator' | 'import';

export interface Provider {
  id: string;
  name: string;
  group: ProviderGroup;
  tag: ProviderTag;
  caps: Capability[];
  form: FormKind;
  /** Broker form also asks for gateway host / port (IB, MT5). */
  gateway?: boolean;
  /** Rust venue id when a live connector exists. */
  venue?: string;
  /** Symbol used by the wizard's connection test (instrument metadata over REST). */
  testSymbol?: string;
  /** Market description shown in the Connections list ("USDⓈ-M", "Linear perps", …). */
  market?: string;
  /** Built-in simulator (always available). */
  simulator?: 'mock' | 'crypto';
  /** Short description shown at the top of the form. */
  blurb: string;
  /** Why it is not available yet (shown as "Coming soon / requires SDK"). */
  blocked?: string;
}

const broker = (
  id: string,
  name: string,
  group: ProviderGroup,
  caps: Capability[],
  blocked: string,
  extra: Partial<Provider> = {},
): Provider => ({
  id,
  name,
  group,
  tag: 'YOUR ACCOUNT',
  caps,
  form: 'broker',
  blurb:
    'Uses your own broker / data account. Exchange fees and data subscriptions are billed by them.',
  blocked,
  ...extra,
});

const FUT: Capability[] = ['Trades', 'L2 depth', 'Trading'];
const FUT_MBO: Capability[] = ['Trades', 'L2 depth', 'MBO', 'Trading'];
const NEEDS_SDK = 'Requires the vendor SDK / API licence (see docs/BLOCKERS.md)';

const crypto = (
  id: string,
  name: string,
  caps: Capability[],
  live?: { venue: string; testSymbol: string; market: string },
): Provider => ({
  id,
  name,
  group: 'Crypto',
  tag: 'FREE',
  caps,
  form: 'crypto',
  ...live,
  blurb: 'Free public market data — no API key needed. Add a key only to trade.',
  blocked: live ? undefined : 'Connector planned (P05) — not implemented yet',
});

const PERP: Capability[] = ['Trades', 'L2 depth', 'Funding', 'Liquidations', 'OI'];

export const PROVIDERS: Provider[] = [
  broker('amp-cqg', 'AMP/CQG', 'US and EU markets', FUT, NEEDS_SDK),
  broker('cqg', 'CQG', 'US and EU markets', FUT, NEEDS_SDK),
  broker('cts', 'CTS', 'US and EU markets', FUT, NEEDS_SDK),
  broker(
    'datafeed-prime',
    'DataFeed Prime',
    'US and EU markets',
    ['Trades', 'L2 depth'],
    NEEDS_SDK,
  ),
  broker('dprimevu', 'DPrimeVU (dxFeed)', 'US and EU markets', ['Trades', 'L2 depth'], NEEDS_SDK),
  broker('dxfeed', 'dxFeed', 'US and EU markets', ['Trades', 'L2 depth'], NEEDS_SDK),
  broker('exante', 'Exante', 'US and EU markets', FUT, NEEDS_SDK),
  broker('ib', 'Interactive Brokers', 'US and EU markets', FUT, NEEDS_SDK, { gateway: true }),
  broker('iqfeed', 'IQFeed', 'US and EU markets', ['Trades', 'L2 depth'], NEEDS_SDK),
  broker('mt5', 'MT5', 'US and EU markets', ['Trades', 'Trading'], NEEDS_SDK, { gateway: true }),
  broker('ninjatrader', 'NinjaTrader', 'US and EU markets', FUT, NEEDS_SDK),
  broker('plus500', 'Plus500', 'US and EU markets', FUT, NEEDS_SDK),
  broker('rithmic', 'Rithmic', 'US and EU markets', FUT_MBO, NEEDS_SDK),
  broker('rithmic-ext', 'Rithmic (extended)', 'US and EU markets', FUT_MBO, NEEDS_SDK),
  broker('stonex-cqg', 'StoneX-CQG', 'US and EU markets', FUT, NEEDS_SDK),
  broker('tai-pan', 'TAI-PAN', 'US and EU markets', ['Trades'], NEEDS_SDK),
  broker('tradovate', 'Tradovate', 'US and EU markets', FUT, NEEDS_SDK),
  broker('alpaca', 'Alpaca (IEX)', 'US and EU markets', ['Trades', 'Trading'], NEEDS_SDK),
  broker('ttp-dxfeed', 'TheTradingPit dxFeed', 'Prop connections', FUT, NEEDS_SDK),
  broker('prop-rithmic', 'Prop firm · Rithmic', 'Prop connections', FUT_MBO, NEEDS_SDK),
  broker('prop-tradovate', 'Prop firm · Tradovate', 'Prop connections', FUT, NEEDS_SDK),
  crypto('binance', 'Binance', ['Trades', 'L2 depth'], {
    venue: 'binance-spot',
    testSymbol: 'BTCUSDT',
    market: 'Spot',
  }),
  crypto('binance-futures', 'Binance Futures', PERP, {
    venue: 'binance-futures',
    testSymbol: 'BTCUSDT',
    market: 'USDⓈ-M',
  }),
  crypto('binance-coinm', 'Binance COIN-M', PERP, {
    venue: 'binance-coinm',
    testSymbol: 'BTCUSD_PERP',
    market: 'COIN-M',
  }),
  crypto('bitfinex', 'Bitfinex', PERP, {
    venue: 'bitfinex',
    testSymbol: 'tBTCF0:USTF0',
    market: 'Perpetuals and spot',
  }),
  crypto('bitget', 'Bitget', PERP, {
    venue: 'bitget',
    testSymbol: 'BTCUSDT',
    market: 'USDT-M futures',
  }),
  crypto('bitmex', 'BitMEX', PERP),
  crypto('bybit', 'Bybit', ['Trades', 'L2 depth'], {
    venue: 'bybit-linear',
    testSymbol: 'BTCUSDT',
    market: 'Linear perps',
  }),
  crypto('deribit', 'Deribit', ['Trades', 'L2 depth', 'Funding', 'Liquidations', 'OI'], {
    venue: 'deribit',
    testSymbol: 'BTC-PERPETUAL',
    market: 'Perpetuals, futures, options chain',
  }),
  crypto('kraken', 'Kraken', PERP, {
    venue: 'kraken-futures',
    testSymbol: 'PF_XBTUSD',
    market: 'Futures (flexible perpetuals)',
  }),
  crypto('okx', 'OKX', PERP, {
    venue: 'okx-swap',
    testSymbol: 'BTC-USDT-SWAP',
    market: 'Perpetual swaps',
  }),
  crypto('phemex', 'Phemex', ['Trades', 'L2 depth', 'Funding', 'OI'], {
    venue: 'phemex',
    testSymbol: 'BTCUSDT',
    market: 'USDT perpetuals (hedged)',
  }),
  crypto('whitebit', 'Whitebit', ['Trades', 'L2 depth']),
  {
    id: 'ht-sim',
    name: 'HT Sim (15-min delayed)',
    group: 'Simulator',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth', 'Trading'],
    form: 'simulator',
    simulator: 'mock',
    blurb: 'Built-in simulated futures market with a paper account.',
  },
  {
    id: 'crypto-data',
    name: 'Crypto data',
    group: 'Simulator',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth'],
    form: 'simulator',
    simulator: 'crypto',
    blurb: 'Free crypto market data for paper trading.',
  },
  {
    id: 'crypto-sim',
    name: 'Crypto Sim',
    group: 'Simulator',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth', 'Trading'],
    form: 'simulator',
    simulator: 'crypto',
    blurb: 'Built-in simulated crypto market with a paper account.',
  },
  {
    id: 'dxfeed-delayed',
    name: 'dxFeed (15-min delayed)',
    group: 'Simulator',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth'],
    form: 'simulator',
    blurb: 'Delayed CME / CBOT / NYMEX / COMEX demo data.',
    blocked: 'Needs a dxFeed demo endpoint (see docs/BLOCKERS.md)',
  },
  {
    id: 'sbe',
    name: 'SBE',
    group: 'Simulator',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth', 'MBO'],
    form: 'simulator',
    blurb: 'CME MDP 3.0 (SBE) sample-file playback.',
    blocked: 'SBE decoder not implemented yet',
  },
  broker('exante-other', 'Exante', 'Other', FUT, NEEDS_SDK),
  broker('mt5-other', 'MT5', 'Other', ['Trades', 'Trading'], NEEDS_SDK, { gateway: true }),
  broker('quik', 'Quik', 'Other', FUT, NEEDS_SDK),
  broker('transaq', 'Transaq Connector', 'Other', FUT, NEEDS_SDK),
  {
    id: 'csv-import',
    name: 'CSV / Parquet import',
    group: 'Other',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth'],
    form: 'import',
    blurb: 'Import ticks from CSV / Parquet files into the local tick store.',
    blocked: 'Importer arrives with P06 import (Data manager exports CSV today)',
  },
  {
    id: 'custom-ws',
    name: 'Custom WebSocket',
    group: 'Other',
    tag: 'FREE',
    caps: ['Trades', 'L2 depth'],
    form: 'import',
    blurb: 'Any JSON WebSocket feed with a field mapping.',
    blocked: 'JSON-mapping connector not implemented yet',
  },
];

export const GROUPS: ProviderGroup[] = [
  'US and EU markets',
  'Prop connections',
  'Crypto',
  'Simulator',
  'Other',
];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Case-insensitive search on name, group and capabilities, grouped in spec order. */
export function searchProviders(q: string): { group: ProviderGroup; items: Provider[] }[] {
  const s = q.trim().toLowerCase();
  return GROUPS.map((group) => ({
    group,
    items: PROVIDERS.filter(
      (p) =>
        p.group === group &&
        (!s ||
          p.name.toLowerCase().includes(s) ||
          group.toLowerCase().includes(s) ||
          p.caps.some((c) => c.toLowerCase().includes(s))),
    ),
  })).filter((g) => g.items.length);
}

export function isAvailable(p: Provider): boolean {
  return !p.blocked;
}

export type LatencyLevel = 'ok' | 'warn' | 'bad' | 'none';

/** Data-delay thresholds (defaults of Common Settings → Data delays). */
export const LATENCY_WARN_MS = 250;
export const LATENCY_CRITICAL_MS = 1000;

export function latencyLevel(
  ms: number | null,
  warn = LATENCY_WARN_MS,
  crit = LATENCY_CRITICAL_MS,
): LatencyLevel {
  if (ms === null || !Number.isFinite(ms)) return 'none';
  return ms < warn ? 'ok' : ms < crit ? 'warn' : 'bad';
}

export interface ConnectionConfig {
  id: string;
  provider: string;
  name: string;
  environment: 'live' | 'testnet' | 'demo';
  server?: string;
  username?: string;
  gatewayHost?: string;
  gatewayPort?: number;
  startingBalance?: number;
  marketData: boolean;
  trading: boolean;
  record: boolean;
  connectOnStart: boolean;
  /** Credentials were stored in the vault under connections.<id>.* */
  hasSecret?: boolean;
}

export interface ConnectionsDoc {
  autoConnect: boolean;
  list: ConnectionConfig[];
}

export const DEFAULT_CONNECTIONS: ConnectionsDoc = {
  autoConnect: true,
  list: [
    {
      id: 'binance-futures',
      provider: 'binance-futures',
      name: 'Binance Futures',
      environment: 'live',
      marketData: true,
      trading: false,
      record: true,
      connectOnStart: true,
    },
    {
      id: 'bybit',
      provider: 'bybit',
      name: 'Bybit',
      environment: 'live',
      marketData: true,
      trading: false,
      record: true,
      connectOnStart: true,
    },
    {
      id: 'ht-sim',
      provider: 'ht-sim',
      name: 'HT Sim (15-min delayed)',
      environment: 'demo',
      startingBalance: 50_000,
      marketData: true,
      trading: true,
      record: false,
      connectOnStart: true,
    },
  ],
};

/** Validates a wizard form; returns field → message. */
export function validateConnection(p: Provider, c: ConnectionConfig): Record<string, string> {
  const e: Record<string, string> = {};
  if (!c.name.trim()) e.name = 'Name is required';
  else if (c.name.length > 60) e.name = 'At most 60 characters';
  if (p.form === 'broker') {
    if (!c.server?.trim()) e.server = 'Server / system is required';
    if (!c.username?.trim()) e.username = 'Username is required';
    if (p.gateway) {
      if (!c.gatewayHost?.trim()) e.gatewayHost = 'Gateway host is required';
      const port = c.gatewayPort ?? 0;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) e.gatewayPort = 'Port 1–65535';
    }
  }
  if (p.form === 'simulator') {
    const b = c.startingBalance ?? 0;
    if (!Number.isFinite(b) || b < 100 || b > 100_000_000) e.startingBalance = '100 – 100,000,000';
  }
  if (!c.marketData && !c.trading) e.options = 'Use it for market data, trading or both';
  return e;
}
