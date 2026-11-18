import { describe, expect, it } from 'vitest';
import type { Level, Zone } from '@htflow/indicator-sdk';
import { generateSimChain, simUnderlying } from '@htflow/options';
import { CATALOG, isImplemented } from './index';
import { chainToData } from './optionsChain';
import { marginBands, marginReference, parseTiers, profileSessions } from './extras';
import { items, mkBars, ohlcBars, run, vals } from './testkit';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('catalog', () => {
  it('has no pending entries left', () => {
    expect(CATALOG.filter((e) => !isImplemented(e)).map((e) => e.name)).toEqual([]);
  });
});

describe('CMS (Cumulative Market Sentiment)', () => {
  it('is the windowed net aggressive volume share, smoothed', () => {
    // delta +4 on volume 10 every bar -> 40 %; window 3, no smoothing (EMA 1).
    const bars = mkBars([1, 2, 3, 4, 5], { vol: [10, 10, 10, 10, 10], delta: [4, 4, 4, 4, 4] });
    const v = vals(run('cms', bars, { period: 3, smooth: 1 }), 'cms');
    expect(v[1]).toBeNaN();
    expect(v[2]).toBeCloseTo(40);
    expect(v[4]).toBeCloseTo(40);
  });

  it('is -100 when everything is sold and 0 without volume', () => {
    const sell = mkBars([1, 1, 1], { vol: [5, 5, 5], delta: [-5, -5, -5] });
    expect(vals(run('cms', sell, { period: 2, smooth: 1 }), 'cms')[2]).toBeCloseTo(-100);
    const none = mkBars([1, 1, 1], { vol: [0, 0, 0], delta: [0, 0, 0] });
    expect(vals(run('cms', none, { period: 2, smooth: 1 }), 'cms')[2]).toBe(0);
  });

  it('smooths with an EMA seeded by the SMA', () => {
    const bars = mkBars([1, 2, 3, 4], { vol: [10, 10, 10, 10], delta: [10, 10, -10, -10] });
    const v = vals(run('cms', bars, { period: 1, smooth: 2 }), 'cms');
    expect(v[1]).toBeCloseTo(100); // SMA of 100, 100
    expect(v[2]).toBeCloseTo(100 + (2 / 3) * (-100 - 100));
  });
});

describe('Margin Zones maths', () => {
  it('parses leverage tiers', () => {
    expect(parseTiers('10, 5x; 25 abc 5 0 5000')).toEqual([5, 10, 25]);
  });

  it('puts the liquidation of each tier at 1/L - mmr from the reference', () => {
    const b = marginBands(100, [10, 20], 0.005);
    const long20 = b.find((x) => x.side === 'long' && x.leverage === 20)!;
    const long10 = b.find((x) => x.side === 'long' && x.leverage === 10)!;
    const short20 = b.find((x) => x.side === 'short' && x.leverage === 20)!;
    // 20x: 5 % - 0.5 % = 4.5 % away; 10x: 10 % - 0.5 % = 9.5 % away.
    expect(long20.to).toBeCloseTo(100);
    expect(long20.from).toBeCloseTo(95.5);
    expect(long10.to).toBeCloseTo(95.5);
    expect(long10.from).toBeCloseTo(90.5);
    expect(short20.from).toBeCloseTo(100);
    expect(short20.to).toBeCloseTo(104.5);
  });

  it('drops tiers whose initial margin is below the maintenance margin', () => {
    const b = marginBands(100, [5, 400], 0.01);
    expect(b.map((x) => x.leverage)).toEqual([5, 5]);
  });

  it('anchors to the day open, week open or last close', () => {
    const t0 = Date.UTC(2026, 10, 16); // Monday
    const bars = ohlcBars(
      [
        [10, 12, 9, 11],
        [11, 13, 10, 12],
        [12, 14, 11, 13],
        [13, 15, 12, 14],
      ],
      { t0: t0 + 20 * HOUR, ms: 2 * HOUR },
    );
    // bar0 Mon 20:00, bar1 Mon 22:00, bar2 Tue 00:00, bar3 Tue 02:00
    expect(marginReference(bars, 'day-open')).toBe(12);
    expect(marginReference(bars, 'week-open')).toBe(10);
    expect(marginReference(bars, 'last-close')).toBe(14);
  });

  it('draws one zone per tier and side plus the reference level', () => {
    const bars = mkBars([100, 100, 100], { t0: Date.UTC(2026, 10, 16), ms: HOUR });
    const rt = run('margin-zones', bars, { tiers: '5, 10', anchor: 'last-close', mmr: 0.5 });
    const zones = items<Zone>(rt, 'zones');
    expect(zones).toHaveLength(4);
    expect(zones.filter((z) => z.tone === 0).every((z) => z.bottom >= 100)).toBe(true);
    expect(zones.filter((z) => z.tone === 1).every((z) => z.top <= 100)).toBe(true);
    expect(items<Level>(rt, 'ref')[0]!.value).toBe(100);
  });
});

describe('Market Profile', () => {
  // 30-minute bars of one UTC day with price in ticks.
  const t0 = Date.UTC(2026, 10, 16);
  const day = ohlcBars(
    [
      [10, 12, 10, 11], // A: rows 10..12
      [11, 13, 10, 12], // B: rows 10..13
      [12, 12, 11, 11], // C: rows 11..12
      [11, 12, 10, 10], // D: rows 10..12
      [10, 17, 10, 16], // E: rows 10..17 (rows 14..17 single prints)
    ],
    { t0, ms: 30 * 60_000 },
  );

  it('finds POC, value area, IB and single prints', () => {
    const [s] = profileSessions(day, {
      session: 'D',
      sessions: 1,
      rowTicks: 1,
      valueAreaPct: 70,
      ibPeriods: 2,
    });
    expect(s).toBeDefined();
    expect(s!.poc).toBeGreaterThanOrEqual(10);
    expect(s!.poc).toBeLessThanOrEqual(14);
    expect(s!.val).toBeLessThanOrEqual(s!.poc);
    expect(s!.vah).toBeGreaterThanOrEqual(s!.poc);
    expect(s!.ibLow).toBe(10);
    expect(s!.ibHigh).toBe(14);
    expect(s!.singles).toEqual([{ bottom: 14, top: 18 }]);
    expect(s!.high).toBe(18);
    expect(s!.low).toBe(10);
    expect(s!.poorLow).toBe(true);
    expect(s!.poorHigh).toBe(false);
    expect(s!.from).toBe(0);
    expect(s!.to).toBe(4);
  });

  it('keeps only the last N sessions and maps them to bar ranges', () => {
    const two = [
      ...ohlcBars(
        [
          [10, 12, 10, 11],
          [11, 12, 10, 11],
        ],
        { t0, ms: HOUR },
      ),
      ...ohlcBars(
        [
          [20, 22, 20, 21],
          [21, 22, 20, 21],
        ],
        { t0: t0 + DAY, ms: HOUR },
      ),
    ];
    const one = profileSessions(two, {
      session: 'D',
      sessions: 1,
      rowTicks: 1,
      valueAreaPct: 70,
      ibPeriods: 2,
    });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ from: 2, to: 3 });
    const both = profileSessions(two, {
      session: 'D',
      sessions: 5,
      rowTicks: 1,
      valueAreaPct: 70,
      ibPeriods: 2,
    });
    expect(both.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('the indicator draws POC / VAH / VAL levels and a value-area zone', () => {
    const rt = run('market-profile', day, { sessions: 1, rowTicks: 1 });
    const labels = items<Level>(rt, 'levels').map((l) => l.label);
    expect(labels).toEqual(expect.arrayContaining(['POC', 'VAH', 'VAL', 'IB high', 'IB low']));
    const zones = items<Zone>(rt, 'zones');
    expect(zones.some((z) => z.label === 'VA')).toBe(true);
    expect(zones.some((z) => z.label === 'single')).toBe(true);
  });
});

describe('options indicators read ctx.options', () => {
  const u = simUnderlying('mock:ESZ6')!;
  const now = Date.UTC(2026, 10, 16, 12);
  const data = chainToData(generateSimChain(u, null, now), 1);
  const bars = mkBars([6850, 6851, 6852], { t0: now - 3 * HOUR, ms: HOUR });

  it('show a note and no output without a chain', () => {
    const rt = run('options-board', bars, {});
    expect(rt.notice).toMatch(/loading or not available/);
    expect(items(rt, 'levels')).toHaveLength(0);
  });

  it('Options Board: strikes with OI, volume and IV, max pain, labelled Sim', () => {
    const rt = run('options-board', bars, { strikes: 7 }, { options: data });
    const lv = items<Level>(rt, 'levels');
    expect(lv.filter((l) => l.tone !== 2)).toHaveLength(7);
    expect(lv.find((l) => l.label?.startsWith('Max pain'))).toBeDefined();
    expect(lv[0]!.label).toMatch(/OI .*\/.* {2}Vol .* {2}IV \d+\.\d%/);
    expect(rt.notice).toMatch(/^Sim \(simulated\)/);
  });

  it('Volatility Smile: markers for each expiry inside the strike range', () => {
    const rt = run('volatility-smile', bars, { count: 2, range: 10 }, { options: data });
    const m = items<{ bar: number; shape: string; tone: number }>(rt, 'points');
    expect(m.filter((x) => x.shape === 'circle').length).toBeGreaterThan(4);
    expect(new Set(m.map((x) => x.tone)).size).toBe(2);
    expect(rt.notice).toMatch(/simulated/);
    for (const x of m) expect(x.bar).toBeLessThanOrEqual(2);
  });
});
