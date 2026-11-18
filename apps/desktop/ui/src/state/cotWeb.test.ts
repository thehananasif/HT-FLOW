import { describe, expect, it, vi } from 'vitest';
import { buildCotUrl, cotFetchWeb, parseCotRows } from './cotWeb';

const TFF_ROW = (date: string, extra: Record<string, string> = {}) => ({
  report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
  open_interest_all: '2603046',
  change_in_open_interest_all: '1000',
  dealer_positions_long_all: '548735',
  dealer_positions_short_all: '156360',
  dealer_positions_spread_all: '186943',
  change_in_dealer_long_all: '100',
  change_in_dealer_short_all: '-50',
  asset_mgr_positions_long: '937649',
  asset_mgr_positions_short: '100',
  ...extra,
});

describe('COT browser fallback', () => {
  it('builds the same query as the desktop crate', () => {
    const url = buildCotUrl('tff', '13874A', '2020-01-01');
    expect(url.startsWith('https://publicreporting.cftc.gov/resource/gpe5-46if.json?')).toBe(true);
    expect(decodeURIComponent(url)).toContain(
      "$where=cftc_contract_market_code='13874A' AND report_date_as_yyyy_mm_dd>='2020-01-01'",
    );
    expect(url).toContain('$order=report_date_as_yyyy_mm_dd%20ASC&$limit=3000');
    expect(buildCotUrl('legacy', '088691', '2020-01-01')).toContain('/6dca-aqww.json');
    expect(buildCotUrl('disagg', '088691', '2020-01-01')).toContain('/72hh-3qpy.json');
  });

  it('rejects bad market codes and dates (no query injection)', () => {
    expect(() => buildCotUrl('tff', "x' OR 1=1", '2020-01-01')).toThrow(/market code/);
    expect(() => buildCotUrl('tff', '13874A', '2020-1-1')).toThrow(/YYYY-MM-DD/);
  });

  it('parses rows: strings to numbers, sorted, de-duplicated, net and changes', () => {
    const rows = parseCotRows(
      'tff',
      JSON.stringify([
        TFF_ROW('2026-11-03'),
        TFF_ROW('2026-10-27'),
        TFF_ROW('2026-10-27'),
        { report_date_as_yyyy_mm_dd: '2026-10-20T00:00:00.000' },
      ]),
    );
    expect(rows.map((r) => r.date)).toEqual(['2026-10-27', '2026-11-03']);
    const r = rows[1]!;
    expect(r.openInterest).toBe(2603046);
    expect(r.oiChange).toBe(1000);
    expect(r.groups.map((g) => g.key)).toEqual([
      'dealer',
      'assetmgr',
      'levmoney',
      'other',
      'nonreportable',
    ]);
    expect(r.groups[0]).toMatchObject({
      long: 548735,
      short: 156360,
      spread: 186943,
      net: 392375,
      netChange: 150,
    });
    expect(r.groups[4]).toMatchObject({ long: 0, short: 0, net: 0 });
  });

  it('reports API error objects and bad JSON', () => {
    expect(() => parseCotRows('tff', '{"message":"Query coordinator error"}')).toThrow(
      /Query coordinator error/,
    );
    expect(() => parseCotRows('tff', 'nope')).toThrow(/not valid JSON/);
  });

  it('fetches through the injected fetch and maps failures to offline codes', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify([TFF_ROW('2026-11-03')])));
    const r = await cotFetchWeb(
      { report: 'tff', marketCode: '13874A', fromDate: '2024-01-01' },
      ok as unknown as typeof fetch,
    );
    expect(r.source).toBe('network');
    expect(r.rows).toHaveLength(1);
    const bad = vi.fn(async () => new Response('x', { status: 503 }));
    await expect(
      cotFetchWeb(
        { report: 'tff', marketCode: '13874A', fromDate: '2024-01-01' },
        bad as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'cot.http' });
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      cotFetchWeb(
        { report: 'tff', marketCode: '13874A', fromDate: '2024-01-01' },
        down as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'cot.network' });
  });
});
