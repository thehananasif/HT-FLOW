import { afterEach, describe, expect, it } from 'vitest';
import { catalog, type DiscoveryReport } from '@htflow/market-catalog';
import type { Instrument } from '@htflow/market-data';
import {
  applyDiscovery,
  discoveredExtras,
  discoveredFeed,
  discoverySummary,
  registerBuiltInFeeds,
  withDiscovered,
} from './discovery';

const BUILT_IN: Instrument[] = [
  {
    id: 'okx-swap:BTC-USDT-SWAP',
    symbol: 'BTC-USDT-SWAP',
    displayName: 'BTC-USDT-SWAP Perpetual',
    exchange: 'OKX',
    assetClass: 'crypto',
    tickSize: 1,
    pricePrecision: 0,
    qtyPrecision: 0,
    tickValue: 0,
    currency: 'USDT',
  },
];

const row = (symbol: string, market: 'perp' | 'spot', tick: number, venue = 'okx-swap') => ({
  venue,
  market,
  symbol,
  base: symbol.split('-')[0]!,
  quote: 'USDT',
  settle: 'USDT',
  inverse: false,
  tickSize: tick,
  pricePrecision: Math.max(0, -Math.round(Math.log10(tick))),
  lotStep: 0.01,
  qtyPrecision: 2,
  minQty: 0.01,
  contractSize: 1,
});

const REPORT: DiscoveryReport = {
  refreshedAtMs: 1,
  stale: false,
  sources: [
    {
      id: 'okx-swap',
      label: 'OKX perpetual swaps',
      ok: true,
      fetchedAtMs: 1,
      count: 2,
      instruments: [row('BTC-USDT-SWAP', 'perp', 0.1), row('WIF-USDT-SWAP', 'perp', 0.0001)],
    },
    {
      id: 'bybit-spot',
      label: 'Bybit spot',
      ok: false,
      error: 'HTTP 403',
      fetchedAtMs: 0,
      count: 1,
      instruments: [row('SOLUSDT', 'spot', 0.01, 'bybit-spot')],
    },
  ],
};

afterEach(() => applyDiscovery(null));

describe('symbol discovery (UI)', () => {
  it('adds discovered symbols to a live venue and updates built-in specs', () => {
    registerBuiltInFeeds('okx-swap', BUILT_IN);
    applyDiscovery(REPORT);
    const list = withDiscovered('okx-swap', BUILT_IN);
    expect(list.map((i) => i.id)).toEqual(['okx-swap:BTC-USDT-SWAP', 'okx-swap:WIF-USDT-SWAP']);
    expect(list[0]).toMatchObject({ tickSize: 0.1, pricePrecision: 1, qtyPrecision: 2 });
    expect(discoveredFeed('okx-swap:WIF-USDT-SWAP')).toMatchObject({
      tickSize: 0.0001,
      pricePrecision: 4,
      displayName: 'WIF-USDT-SWAP Perpetual',
    });
    // Bybit spot streams through the connector: its discovered symbols become feeds too.
    expect(discoveredFeed('bybit-spot:SOLUSDT')).toMatchObject({ tickSize: 0.01 });
    expect(discoveredExtras().map((i) => i.id)).toEqual([
      'okx-swap:WIF-USDT-SWAP',
      'bybit-spot:SOLUSDT',
    ]);
    // …and are in the catalog.
    expect(catalog().get('cat:BYBIT-SPOT:SOLUSDT')).toBeDefined();
    expect(catalog().get('cat:OKX:WIF-USDT-SWAP')?.tickSize).toBe(0.0001);
  });

  it('summarises sources and clears on an empty report', () => {
    applyDiscovery(REPORT);
    expect(discoverySummary(REPORT).map((s) => [s.id, s.count, s.ok])).toEqual([
      ['okx-swap', 2, true],
      ['bybit-spot', 1, false],
    ]);
    applyDiscovery(null);
    expect(withDiscovered('okx-swap', BUILT_IN)).toEqual(BUILT_IN);
    expect(catalog().get('cat:OKX:WIF-USDT-SWAP')).toBeUndefined();
  });
});
