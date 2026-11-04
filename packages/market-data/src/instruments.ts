import type { Instrument } from './types';
import type { SimConfig } from './simulator';

export interface MockInstrument {
  instrument: Instrument;
  sim: Omit<SimConfig, 'seed'>;
}

const fut = (
  symbol: string,
  root: string,
  exchange: string,
  tickSize: number,
  pricePrecision: number,
  tickValue: number,
  price: number,
  sim: Partial<SimConfig>,
): MockInstrument => ({
  instrument: {
    id: `mock:${symbol}`,
    symbol,
    displayName: `Continuous(${root})`,
    exchange,
    assetClass: 'future',
    tickSize,
    pricePrecision,
    qtyPrecision: 0,
    tickValue,
    currency: 'USD',
  },
  sim: {
    startPx: Math.round(price / tickSize),
    orderRate: 3,
    meanQty: 3,
    qtyPrecision: 0,
    levels: 120,
    baseDepth: 9,
    ...sim,
  },
});

/** Instruments available on the built-in MockFeed (seeded, offline, $0). */
export const MOCK_INSTRUMENTS: MockInstrument[] = [
  {
    instrument: {
      id: 'mock:BTCUSDT',
      symbol: 'BTCUSDT',
      displayName: 'BTCUSDT Perpetual',
      exchange: 'Crypto Sim',
      assetClass: 'crypto',
      tickSize: 0.1,
      pricePrecision: 1,
      qtyPrecision: 3,
      tickValue: 0,
      currency: 'USDT',
    },
    sim: {
      startPx: 682_000,
      orderRate: 7,
      meanQty: 0.08,
      qtyPrecision: 3,
      levels: 150,
      baseDepth: 0.6,
    },
  },
  fut('CLZ6', 'CL', 'NYMEX', 0.01, 2, 10, 91.5, { orderRate: 3.2, meanQty: 2, baseDepth: 8 }),
  fut('GCZ6', 'GC', 'COMEX', 0.1, 1, 10, 4051.0, { orderRate: 2.6, meanQty: 2, baseDepth: 7 }),
  fut('ESZ6', 'ES', 'CME', 0.25, 2, 12.5, 6850, { orderRate: 4, meanQty: 4, baseDepth: 25 }),
  fut('NQZ6', 'NQ', 'CME', 0.25, 2, 5, 24810, { orderRate: 3.5, meanQty: 2, baseDepth: 6 }),
];

export function findMockInstrument(idOrSymbol: string): MockInstrument | undefined {
  return MOCK_INSTRUMENTS.find(
    (m) => m.instrument.id === idOrSymbol || m.instrument.symbol === idOrSymbol,
  );
}
