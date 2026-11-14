import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOG_SEED,
  catalog,
  catalogVersion,
  matchFeedInstrument,
  mergeDiscovered,
  setDiscoveredInstruments,
  type DiscoveredInstrument,
} from './index';

const d = (p: Partial<DiscoveredInstrument> & Pick<DiscoveredInstrument, 'venue' | 'symbol'>) =>
  ({
    market: 'perp',
    base: 'BTC',
    quote: 'USDT',
    settle: 'USDT',
    inverse: false,
    tickSize: 0.1,
    pricePrecision: 1,
    lotStep: 0.001,
    qtyPrecision: 3,
    minQty: 0.001,
    contractSize: 1,
    ...p,
  }) satisfies DiscoveredInstrument;

afterEach(() => {
  setDiscoveredInstruments([]);
});

describe('mergeDiscovered', () => {
  it('overrides seed specs but keeps the curated name, id and sessions', () => {
    const seed = CATALOG_SEED.find((c) => c.id === 'cat:BINANCE-FUTURES:BTCUSDT')!;
    const merged = mergeDiscovered(CATALOG_SEED, [
      d({ venue: 'binance-futures', symbol: 'BTCUSDT', tickSize: 0.5, pricePrecision: 1 }),
    ]);
    const m = merged.find((c) => c.id === seed.id)!;
    expect(m.name).toBe(seed.name);
    expect(m.sessions).toBe(seed.sessions);
    expect(m.tickSize).toBe(0.5);
    expect(m.verified).toBe(true);
    // The simulator mapping survives next to the real feed.
    expect(m.providers.map((p) => p.provider)).toEqual(['binance-futures', 'sim']);
  });

  it('maps seed provider keys onto the real feed (Phemex, WhiteBIT, OKX spot)', () => {
    const merged = mergeDiscovered(CATALOG_SEED, [
      d({ venue: 'phemex', symbol: 'BTCUSDT' }),
      d({ venue: 'okx-swap', market: 'spot', symbol: 'BTC-USDT', tickSize: 0.1 }),
    ]);
    const ph = merged.find((c) => c.id === 'cat:PHEMEX:BTCUSDT')!;
    expect(ph.providers[0]).toEqual({ provider: 'phemex', symbol: 'BTCUSDT' });
    const okx = merged.find((c) => c.id === 'cat:OKX-SPOT:BTC-USDT')!;
    expect(okx.providers[0]).toEqual({ provider: 'okx-swap', symbol: 'BTC-USDT' });
    expect(okx.subGroup).toBe('OKX Spot');
  });

  it('adds every new symbol, grouped by venue/market, and drops placeholders of covered venues', () => {
    const merged = mergeDiscovered(CATALOG_SEED, [
      d({
        venue: 'okx-swap',
        symbol: 'PEPE-USDT-SWAP',
        base: 'PEPE',
        tickSize: 1e-10,
        pricePrecision: 10,
      }),
      d({
        venue: 'okx-swap',
        market: 'future',
        symbol: 'BTC-USD-261225',
        quote: 'USD',
        settle: 'BTC',
        inverse: true,
        contractSize: 100,
        expiryMs: Date.UTC(2026, 11, 25, 8),
      }),
      d({ venue: 'bybit-inverse', symbol: 'BTCUSD', quote: 'USD', settle: 'BTC', inverse: true }),
    ]);
    const pepe = merged.find((c) => c.symbol === 'PEPE-USDT-SWAP')!;
    expect(pepe).toMatchObject({
      id: 'cat:OKX:PEPE-USDT-SWAP',
      name: 'Pepe Perpetual',
      subGroup: 'OKX Perpetual Futures',
      tickSize: 1e-10,
      pricePrecision: 10,
      verified: true,
    });
    const fut = merged.find((c) => c.symbol === 'BTC-USD-261225')!;
    expect(fut.name).toBe('Bitcoin Inverse futures 25 Dec 2026');
    expect(fut.subGroup).toBe('OKX Futures');
    expect(fut.multiplier).toBe(100);
    expect(
      merged.find((c) => c.symbol === 'BTCUSD' && c.subGroup === 'Bybit Inverse'),
    ).toBeTruthy();
    // OKX quarterly placeholders ("BTC-USD-QUARTER") are not real symbols: dropped.
    expect(merged.some((c) => c.symbol === 'BTC-USD-QUARTER')).toBe(false);
    // Venues the discovery did not cover keep their seed entries.
    expect(merged.some((c) => c.providers.some((p) => p.provider === 'kraken-spot'))).toBe(true);
    expect(new Set(merged.map((c) => c.id)).size).toBe(merged.length);
  });

  it('ignores rows without a tick size and duplicate ids', () => {
    const merged = mergeDiscovered(CATALOG_SEED, [
      d({ venue: 'bitget', symbol: 'ZZZUSDT', tickSize: 0 }),
      d({ venue: 'bitget', symbol: 'NEWUSDT', base: 'NEW' }),
      d({ venue: 'bitget', symbol: 'NEWUSDT', base: 'NEW' }),
    ]);
    expect(merged.filter((c) => c.symbol === 'NEWUSDT')).toHaveLength(1);
    expect(merged.some((c) => c.symbol === 'ZZZUSDT')).toBe(false);
  });
});

describe('shared catalog', () => {
  it('rebuilds with discovered symbols: search and feed matching find them', () => {
    const v = catalogVersion();
    setDiscoveredInstruments([d({ venue: 'binance-futures', symbol: 'WIFUSDT', base: 'WIF' })]);
    expect(catalogVersion()).toBe(v + 1);
    const hit = catalog().index.search('wifusdt')[0];
    expect(hit?.doc.id).toBe('cat:BINANCE-FUTURES:WIFUSDT');
    const m = matchFeedInstrument(catalog(), {
      id: 'binance-futures:WIFUSDT',
      symbol: 'WIFUSDT',
      exchange: 'Binance Futures',
      assetClass: 'crypto',
    });
    expect(m?.id).toBe('cat:BINANCE-FUTURES:WIFUSDT');
    setDiscoveredInstruments([]);
    expect(catalog().get('cat:BINANCE-FUTURES:WIFUSDT')).toBeUndefined();
  });

  it('builds and searches several thousand discovered symbols quickly', () => {
    const many: DiscoveredInstrument[] = [];
    for (let i = 0; i < 8000; i++)
      many.push(d({ venue: i % 2 ? 'okx-swap' : 'bitget', symbol: `C${i}USDT`, base: `C${i}` }));
    const t0 = performance.now();
    const cat = setDiscoveredInstruments(many);
    const built = performance.now() - t0;
    expect(cat.instruments.length).toBeGreaterThan(8000);
    const t1 = performance.now();
    const hits = cat.index.search('c7777');
    const searched = performance.now() - t1;
    expect(hits[0]?.doc.symbol).toBe('C7777USDT');
    expect(built).toBeLessThan(2000);
    expect(searched).toBeLessThan(200);
  });
});
