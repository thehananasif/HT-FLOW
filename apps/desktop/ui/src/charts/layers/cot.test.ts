import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COT_MARKETS, cotMarketFor, cotReportFor } from './cotMarkets';
import { cotData, resolveCot, sampleRows } from './cotModel';
import { DEFAULT_CHART_TYPE_SETTINGS, sanitizeChartTypeSettings } from './settings';
import { cotFromDate, cotKey, isCotStale, useCot, type CotRow } from '../../state/cot';

const row = (date: string): CotRow => ({
  date,
  openInterest: 100,
  oiChange: 1,
  groups: [
    {
      key: 'dealer',
      label: 'D',
      long: 5,
      short: 3,
      spread: 0,
      net: 2,
      longChange: 1,
      shortChange: 0,
      netChange: 1,
    },
  ],
});

// Node test environment: the store reads the mock from `window`.
(globalThis as { window?: unknown }).window = globalThis;

// The web build downloads with a browser fetch; the tests are offline unless they say otherwise.
beforeEach(() => {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as { window?: unknown }).window = globalThis;
  delete window.__HTFLOW_COT_MOCK__;
  useCot.setState({ entries: {} });
});

describe('symbol to CFTC market', () => {
  it('maps roots, contract months, micros and crypto', () => {
    expect(cotMarketFor('ES')?.code).toBe('13874A');
    expect(cotMarketFor('ESZ6')?.root).toBe('ES');
    expect(cotMarketFor('MES')?.root).toBe('ES');
    expect(cotMarketFor('/GC')?.root).toBe('GC');
    expect(cotMarketFor('6EH26')?.root).toBe('6E');
    expect(cotMarketFor('BTCUSDT')?.root).toBe('BTC');
    expect(cotMarketFor('AAPL')).toBeNull();
    expect(cotMarketFor('')).toBeNull();
  });
  it('codes are unique, 6-char CFTC codes; every market lists a report', () => {
    const codes = COT_MARKETS.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const m of COT_MARKETS) {
      expect(m.code).toMatch(/^[0-9A-Z]{6}$/);
      expect(m.reports.length).toBeGreaterThan(0);
    }
    for (const r of [
      'ES',
      'NQ',
      'YM',
      'RTY',
      'CL',
      'NG',
      'GC',
      'SI',
      'HG',
      'ZB',
      'ZN',
      'ZC',
      'ZS',
      'ZW',
      '6E',
      '6J',
      '6B',
      'BTC',
    ])
      expect(
        COT_MARKETS.some((m) => m.root === r),
        r,
      ).toBe(true);
  });
  it('report choice: the default when the market has it, else its first report', () => {
    const es = cotMarketFor('ES')!;
    const gc = cotMarketFor('GC')!;
    expect(cotReportFor(es, 'tff')).toBe('tff');
    expect(cotReportFor(es, 'disagg')).toBe('tff');
    expect(cotReportFor(gc, 'tff')).toBe('disagg');
    expect(cotReportFor(gc, 'legacy')).toBe('legacy');
  });
  it('resolveCot: auto uses the symbol, an override wins', () => {
    const c = DEFAULT_CHART_TYPE_SETTINGS.cot;
    expect(resolveCot(c, 'ESZ6', 'tff').market?.root).toBe('ES');
    expect(resolveCot({ ...c, market: 'GC', report: 'legacy' }, 'ESZ6', 'tff')).toMatchObject({
      report: 'legacy',
      market: { root: 'GC' },
    });
    expect(resolveCot(c, 'AAPL', 'tff').market).toBeNull();
  });
});

describe('chart settings', () => {
  it('sanitises the COT block', () => {
    const s = sanitizeChartTypeSettings({
      cot: {
        market: 'bad market!',
        report: 'nope',
        years: 999,
        hidden: ['swap', 3],
        openInterest: true,
      },
    });
    expect(s.cot).toEqual({
      market: 'auto',
      report: 'auto',
      years: 25,
      hidden: ['swap'],
      openInterest: true,
    });
    expect(sanitizeChartTypeSettings({}).cot).toEqual(DEFAULT_CHART_TYPE_SETTINGS.cot);
  });
});

describe('cot store and states', () => {
  const es = cotMarketFor('ES')!;

  it('loads through the native call and exposes rows', async () => {
    const calls: unknown[] = [];
    window.__HTFLOW_COT_MOCK__ = async (a) => {
      calls.push(a);
      return { rows: [row('2026-11-03')], fetchedAt: Date.now(), source: 'network' };
    };
    await useCot.getState().load('tff', es.code, 5);
    expect(calls).toEqual([
      {
        report: 'tff',
        marketCode: '13874A',
        fromDate: cotFromDate(5),
        force: false,
        cacheOnly: false,
      },
    ]);
    const d = cotData(useCot.getState().entries, es, 'tff');
    expect(d.status).toBe('ready');
    expect(d.sample).toBe(false);
    expect(d.rows).toHaveLength(1);
    expect(d.message).toContain('as of 2026-11-03');
  });

  it('no native and no cache: offline with the labelled sample', async () => {
    await useCot.getState().load('tff', es.code, 5);
    const e = useCot.getState().entries[cotKey('tff', es.code)]!;
    expect(e.status).toBe('offline');
    const d = cotData(useCot.getState().entries, es, 'tff');
    expect(d.sample).toBe(true);
    expect(d.rows.length).toBeGreaterThan(100);
    expect(d.message).toMatch(/sample/i);
  });

  it('a stale cache is shown as such, not as sample', async () => {
    window.__HTFLOW_COT_MOCK__ = async () => ({
      rows: [row('2026-10-27')],
      fetchedAt: Date.now() - 10 * 86_400_000,
      source: 'stale-cache',
      warning: 'Could not connect to the CFTC',
    });
    await useCot.getState().load('tff', es.code, 5);
    const d = cotData(useCot.getState().entries, es, 'tff');
    expect(d.sample).toBe(false);
    expect(d.message).toContain('Cached');
    expect(d.message).toContain('Could not connect');
  });

  it('empty result and API errors are not offline', async () => {
    window.__HTFLOW_COT_MOCK__ = async () => ({ rows: [], fetchedAt: 1, source: 'network' });
    await useCot.getState().load('disagg', es.code, 5);
    expect(cotData(useCot.getState().entries, es, 'disagg')).toMatchObject({
      status: 'empty',
      sample: false,
    });
    window.__HTFLOW_COT_MOCK__ = async () => {
      throw { code: 'cot.api', message: 'Query coordinator error' };
    };
    await useCot.getState().load('legacy', es.code, 5);
    expect(cotData(useCot.getState().entries, es, 'legacy')).toMatchObject({
      status: 'error',
      message: 'Query coordinator error',
    });
  });

  it('refreshAll re-downloads every loaded entry with force', async () => {
    const calls: boolean[] = [];
    window.__HTFLOW_COT_MOCK__ = async (a) => {
      calls.push(!!a.force);
      return { rows: [row('2026-11-03')], fetchedAt: 1, source: 'network' };
    };
    await useCot.getState().load('tff', es.code, 5);
    await useCot.getState().load('legacy', es.code, 5);
    await useCot.getState().refreshAll(5);
    expect(calls).toEqual([false, false, true, true]);
  });

  it('no mapped market and the loading state', () => {
    expect(cotData({}, null, 'legacy').status).toBe('no-market');
    expect(cotData({}, es, 'tff').status).toBe('loading');
  });
});

describe('helpers', () => {
  it('sample rows are a legacy layout with consistent changes', () => {
    const r = sampleRows();
    expect(r[0]!.groups.map((g) => g.key)).toEqual([
      'commercial',
      'noncommercial',
      'nonreportable',
    ]);
    expect(r[5]!.groups[0]!.netChange).toBe(r[5]!.groups[0]!.net - r[4]!.groups[0]!.net);
  });
  it('weekly staleness follows the Friday release', () => {
    const sat = Date.UTC(2026, 10, 14, 12); // Saturday
    expect(isCotStale(Date.UTC(2026, 10, 13, 21), sat)).toBe(false);
    expect(isCotStale(Date.UTC(2026, 10, 13, 19), sat)).toBe(true);
  });
  it('from date is the 1 January N years back', () => {
    expect(cotFromDate(5, new Date(Date.UTC(2026, 10, 14)))).toBe('2021-01-01');
  });
});
