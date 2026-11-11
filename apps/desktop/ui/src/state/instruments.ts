import { MOCK_INSTRUMENTS, type Instrument } from '@htflow/market-data';
import { feedProviders } from '../feeds/registry';

/** Free, built-in crypto venues streamed by the Rust connectors (desktop app only). */
const BINANCE_FUTURES: [string, number, number, number][] = [
  ['BTCUSDT', 0.1, 1, 3],
  ['ETHUSDT', 0.01, 2, 3],
  ['SOLUSDT', 0.01, 2, 0],
  ['BNBUSDT', 0.01, 2, 2],
  ['XRPUSDT', 0.0001, 4, 1],
  ['DOGEUSDT', 0.00001, 5, 0],
];

export const LIVE_INSTRUMENTS: Instrument[] = BINANCE_FUTURES.map(
  ([symbol, tickSize, pricePrecision, qtyPrecision]) => ({
    id: `binance-futures:${symbol}`,
    symbol,
    displayName: `${symbol} Perpetual`,
    exchange: 'Binance Futures',
    assetClass: 'crypto',
    tickSize,
    pricePrecision,
    qtyPrecision,
    tickValue: 0,
    currency: 'USDT',
  }),
);

export function allInstruments(includeLive: boolean): Instrument[] {
  const extra = feedProviders()
    .filter((p) => includeLive || !p.desktopOnly)
    .flatMap((p) => p.instruments());
  return [
    ...MOCK_INSTRUMENTS.map((m) => m.instrument),
    ...(includeLive ? LIVE_INSTRUMENTS : []),
    ...extra,
  ];
}

export function instrumentById(id: string): Instrument | undefined {
  return allInstruments(true).find((i) => i.id === id);
}

export const DEFAULT_INSTRUMENT = 'mock:CLZ6';
