import { afterEach, describe, expect, it } from 'vitest';
import { catalog, type DiscoveryReport } from '@htflow/market-catalog';
import { applyDiscovery, enabledSources, failedSources, DISCOVERY_SOURCES } from './discovery';
import { pickerEntries } from './instruments';
import '../feeds/binance';
import '../feeds/okx';

// "Binance and other exchanges: not all coins are shown" — every discovered symbol of every
// source must reach the picker, and a search must list every match (no display cap).
const coin = (i: number) =>
  `C${i.toString(36).toUpperCase().padStart(3, 'A')}`.replace(/[^A-Z0-9]/g, 'X');

function source(id: string, venue: string, market: 'perp' | 'spot' | 'future', n: number) {
  const instruments = Array.from({ length: n }, (_, i) => {
    const base = coin(i);
    const symbol = venue.startsWith('okx')
      ? `${base}-USDT${market === 'spot' ? '' : '-SWAP'}`
      : venue === 'binance-coinm'
        ? `${base}USD_PERP`
        : `${base}USDT`;
    return {
      venue,
      market,
      symbol,
      base,
      quote: venue === 'binance-coinm' ? 'USD' : 'USDT',
      settle: 'USDT',
      inverse: venue === 'binance-coinm',
      tickSize: 0.001,
      pricePrecision: 3,
      lotStep: 1,
      qtyPrecision: 0,
      minQty: 1,
      contractSize: 1,
    };
  });
  return { id, label: id, ok: true, fetchedAtMs: 1, count: n, instruments };
}

const REPORT: DiscoveryReport = {
  refreshedAtMs: 1,
  stale: false,
  sources: [
    source('binance-futures', 'binance-futures', 'perp', 650),
    source('binance-coinm', 'binance-coinm', 'perp', 60),
    source('binance-spot', 'binance-spot', 'spot', 2400),
    source('okx-swap', 'okx-swap', 'perp', 300),
    source('okx-spot', 'okx-swap', 'spot', 700),
    {
      id: 'bybit-spot',
      label: 'Bybit spot',
      ok: false,
      error: 'HTTP 403',
      fetchedAtMs: 0,
      count: 0,
      instruments: [],
    },
  ],
};

afterEach(() => applyDiscovery(null));

describe('instrument picker lists every discovered symbol', () => {
  it('has an entry for each discovered instrument of each venue', () => {
    applyDiscovery(REPORT);
    const entries = pickerEntries(true);
    const total = REPORT.sources.reduce((n, s) => n + s.instruments.length, 0);
    expect(total).toBe(4110);
    for (const src of REPORT.sources) {
      const symbols = new Set(
        entries
          .filter((e) => e.catalog?.providers.some((p) => p.provider === src.instruments[0]?.venue))
          .filter((e) => /-spot$/.test(src.id) === /spot/i.test(e.subGroup))
          .map((e) => e.symbol),
      );
      for (const d of src.instruments)
        expect(symbols.has(d.symbol), `${src.id} ${d.symbol}`).toBe(true);
    }
    // Streamable venues open a live feed (desktop).
    const spot = entries.find((e) => e.symbol === 'CAAZUSDT' && /spot/i.test(e.subGroup));
    expect(spot?.feeds[0]?.id).toBe('binance-spot:CAAZUSDT');
  });

  it('a search returns every match, not the first 400', () => {
    applyDiscovery(REPORT);
    const entries = pickerEntries(true);
    const hits = catalog().index.search('usdt', { limit: Math.max(1000, entries.length) });
    // 650 USDⓈ-M + 2,400 spot + 1,000 OKX rows all mention USDT.
    expect(hits.length).toBeGreaterThanOrEqual(650 + 2400 + 1000);
  });

  it('downloads only enabled venues and retries the failed ones', () => {
    expect(enabledSources(() => true)).toEqual([...DISCOVERY_SOURCES]);
    expect(enabledSources((v) => !v.startsWith('binance'))).not.toContain('binance-spot');
    expect(failedSources(REPORT, DISCOVERY_SOURCES)).toEqual(['bybit-spot']);
    expect(failedSources(REPORT, ['okx-swap'])).toEqual([]);
    expect(failedSources(null, DISCOVERY_SOURCES)).toEqual([]);
  });
});
