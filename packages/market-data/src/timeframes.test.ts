import { describe, expect, it } from 'vitest';
import { BarSeries, specKey, specLabel, type BarSpec, type SessionRules } from './aggregator';
import {
  DAY_MS,
  HOUR_MS,
  INTERVAL_GROUPS,
  WEEK_MS,
  groupOfSpec,
  intervalName,
  intervalToSpec,
  monthBucketEnd,
  monthBucketStart,
  parseInterval,
  specToInterval,
  timeBucketStart,
  validateInterval,
  weekStart,
} from './timeframes';
import type { Trade } from './types';

const utc = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
let id = 0;
const tr = (ts: number, px = 100, qty = 1): Trade => ({ ts, px, qty, side: 'buy', id: id++ });

describe('week and month maths', () => {
  it('weeks start on Monday 00:00 UTC', () => {
    // 2024-05-15 is a Wednesday; its week starts Monday 2024-05-13
    expect(weekStart(utc(2024, 5, 15, 13, 30))).toBe(utc(2024, 5, 13));
    expect(weekStart(utc(2024, 5, 13))).toBe(utc(2024, 5, 13));
    expect(weekStart(utc(2024, 5, 19, 23, 59))).toBe(utc(2024, 5, 13));
    expect(weekStart(utc(2024, 5, 20))).toBe(utc(2024, 5, 20));
    expect(new Date(weekStart(utc(2025, 1, 1))).getUTCDay()).toBe(1);
  });

  it('multi-week buckets stay Monday aligned', () => {
    const s = weekStart(utc(2024, 5, 15), 2);
    expect(new Date(s).getUTCDay()).toBe(1);
    expect(weekStart(s + WEEK_MS + 1000, 2)).toBe(s);
    expect(weekStart(s + 2 * WEEK_MS, 2)).toBe(s + 2 * WEEK_MS);
  });

  it('calendar months follow real month lengths', () => {
    expect(monthBucketStart(utc(2024, 2, 29, 23), 1)).toBe(utc(2024, 2, 1));
    expect(monthBucketEnd(utc(2024, 2, 1), 1)).toBe(utc(2024, 3, 1)); // leap year: 29 days
    expect(monthBucketEnd(utc(2023, 2, 1), 1)).toBe(utc(2023, 3, 1)); // 28 days
    expect(monthBucketEnd(utc(2024, 12, 1), 1)).toBe(utc(2025, 1, 1)); // year rollover
    expect(monthBucketStart(utc(2024, 1, 31, 23, 59), 1)).toBe(utc(2024, 1, 1));
  });

  it('3, 6 and 12 month buckets are quarters, half-years and years', () => {
    expect(monthBucketStart(utc(2024, 5, 20), 3)).toBe(utc(2024, 4, 1));
    expect(monthBucketEnd(utc(2024, 4, 1), 3)).toBe(utc(2024, 7, 1));
    expect(monthBucketStart(utc(2024, 11, 2), 6)).toBe(utc(2024, 7, 1));
    expect(monthBucketStart(utc(2024, 6, 30), 12)).toBe(utc(2024, 1, 1));
    expect(monthBucketEnd(utc(2024, 1, 1), 12)).toBe(utc(2025, 1, 1));
    expect(monthBucketStart(utc(1969, 12, 31), 1)).toBe(utc(1969, 12, 1));
  });

  it('timeBucketStart dispatches on spec shape', () => {
    const ts = utc(2024, 5, 15, 10);
    expect(timeBucketStart(ts, HOUR_MS * 4)).toBe(utc(2024, 5, 15, 8));
    expect(timeBucketStart(ts, WEEK_MS)).toBe(utc(2024, 5, 13));
    expect(timeBucketStart(ts, 30 * DAY_MS, 'month')).toBe(utc(2024, 5, 1));
  });
});

describe('interval parsing and validation', () => {
  const spec = (text: string): BarSpec => {
    const r = parseInterval(text);
    if ('error' in r) throw new Error(r.error);
    return r.spec;
  };
  it('a bare number is minutes', () => {
    expect(spec('15')).toEqual({ kind: 'time', ms: 15 * 60_000 });
  });
  it('understands unit suffixes (m minutes, M months)', () => {
    expect(spec('4h')).toEqual({ kind: 'time', ms: 4 * HOUR_MS });
    expect(spec('1D')).toEqual({ kind: 'time', ms: DAY_MS });
    expect(spec('2w')).toEqual({ kind: 'time', ms: 2 * WEEK_MS });
    expect(spec('7m')).toEqual({ kind: 'time', ms: 7 * 60_000 });
    expect(spec('3M')).toEqual({ kind: 'time', ms: 3 * 30 * DAY_MS, cal: 'month' });
    expect(spec('1y')).toEqual({ kind: 'time', ms: 12 * 30 * DAY_MS, cal: 'month' });
    expect(spec('30s')).toEqual({ kind: 'time', ms: 30_000 });
    expect(spec('1000t')).toEqual({ kind: 'tick', n: 1000 });
    expect(spec('100 ticks')).toEqual({ kind: 'tick', n: 100 });
    expect(spec('500v')).toEqual({ kind: 'volume', n: 500 });
    expect(spec('8r')).toEqual({ kind: 'range', ticks: 8 });
    expect(spec(' 4 hours ')).toEqual({ kind: 'time', ms: 4 * HOUR_MS });
  });
  it('rejects bad input with a message', () => {
    for (const bad of ['', 'abc', '0', '-5', '1.5', '4x', '99999999999d', '0h', '121M']) {
      expect('error' in parseInterval(bad), bad).toBe(true);
    }
  });
  it('validateInterval enforces whole numbers and limits', () => {
    expect(validateInterval('minute', 7)).toBeNull();
    expect(validateInterval('minute', 0)).not.toBeNull();
    expect(validateInterval('minute', 2.5)).not.toBeNull();
    expect(validateInterval('tick', 1_000_001)).not.toBeNull();
    expect(validateInterval('month', 120)).toBeNull();
    expect(validateInterval('month', 121)).not.toBeNull();
    expect(validateInterval('week', 600)).not.toBeNull();
  });
});

describe('interval model', () => {
  it('spec <-> interval round trips for every menu entry', () => {
    for (const g of INTERVAL_GROUPS)
      for (const s of g.specs) {
        const iv = specToInterval(s)!;
        expect(iv, specKey(s)).not.toBeNull();
        expect(specKey(intervalToSpec(iv))).toBe(specKey(s));
        expect(groupOfSpec(s)).toBe(g.id);
      }
  });
  it('lists every requested interval', () => {
    const names = (id: string) =>
      INTERVAL_GROUPS.find((g) => g.id === id)!.specs.map((s) => intervalName(specToInterval(s)!));
    expect(names('ticks')).toEqual(['1 tick', '10 ticks', '100 ticks', '1000 ticks']);
    expect(names('seconds')).toEqual([
      '1 second',
      '5 seconds',
      '10 seconds',
      '15 seconds',
      '30 seconds',
      '45 seconds',
    ]);
    expect(names('minutes')).toHaveLength(8);
    expect(names('hours')).toEqual([
      '1 hour',
      '2 hours',
      '3 hours',
      '4 hours',
      '6 hours',
      '8 hours',
      '12 hours',
    ]);
    expect(names('days')).toEqual([
      '1 day',
      '1 week',
      '1 month',
      '3 months',
      '6 months',
      '12 months',
    ]);
  });
  it('month and 30-day specs have distinct keys and short labels', () => {
    const mo: BarSpec = { kind: 'time', ms: 30 * DAY_MS, cal: 'month' };
    expect(specKey(mo)).not.toBe(specKey({ kind: 'time', ms: 30 * DAY_MS }));
    expect(specLabel(mo)).toBe('Mo');
    expect(specLabel({ kind: 'time', ms: 90 * DAY_MS, cal: 'month' })).toBe('3Mo');
    expect(specLabel({ kind: 'time', ms: 360 * DAY_MS, cal: 'month' })).toBe('Y');
    expect(specLabel({ kind: 'time', ms: 2 * WEEK_MS })).toBe('2W');
  });
});

describe('aggregation of the new intervals', () => {
  it('weekly bars split on Monday', () => {
    const trades = [
      tr(utc(2024, 5, 12, 22)), // Sunday: previous week
      tr(utc(2024, 5, 13, 0, 1)), // Monday
      tr(utc(2024, 5, 17, 12)),
      tr(utc(2024, 5, 20, 1)), // next Monday
    ];
    const bars = BarSeries.build({ kind: 'time', ms: WEEK_MS }, trades).bars;
    expect(bars.map((b) => b.t)).toEqual([utc(2024, 5, 6), utc(2024, 5, 13), utc(2024, 5, 20)]);
    expect(bars[1]!.trades).toBe(2);
  });

  it('calendar-month bars split on real month boundaries', () => {
    const trades = [
      tr(utc(2024, 1, 31, 23, 59), 10),
      tr(utc(2024, 2, 1, 0, 0), 11),
      tr(utc(2024, 2, 29, 23, 59), 12), // leap day still February
      tr(utc(2024, 3, 1, 0, 0), 13),
    ];
    const bars = BarSeries.build({ kind: 'time', ms: 30 * DAY_MS, cal: 'month' }, trades).bars;
    expect(bars.map((b) => b.t)).toEqual([utc(2024, 1, 1), utc(2024, 2, 1), utc(2024, 3, 1)]);
    expect(bars[1]!.c).toBe(12);
    expect(bars[1]!.trades).toBe(2);
  });

  it('3-month bars are calendar quarters', () => {
    const trades = [tr(utc(2024, 3, 31, 23)), tr(utc(2024, 4, 1)), tr(utc(2024, 6, 30, 23))];
    const bars = BarSeries.build({ kind: 'time', ms: 90 * DAY_MS, cal: 'month' }, trades).bars;
    expect(bars.map((b) => b.t)).toEqual([utc(2024, 1, 1), utc(2024, 4, 1)]);
    expect(bars[1]!.trades).toBe(2);
  });

  it('multi-hour bars and tick-count bars', () => {
    const h4 = BarSeries.build({ kind: 'time', ms: 4 * HOUR_MS }, [
      tr(utc(2024, 5, 15, 3, 59)),
      tr(utc(2024, 5, 15, 4, 0)),
      tr(utc(2024, 5, 15, 7, 59)),
      tr(utc(2024, 5, 15, 8, 0)),
    ]).bars;
    expect(h4.map((b) => b.t)).toEqual([
      utc(2024, 5, 15, 0),
      utc(2024, 5, 15, 4),
      utc(2024, 5, 15, 8),
    ]);
    const ticks = BarSeries.build(
      { kind: 'tick', n: 10 },
      Array.from({ length: 25 }, (_, i) => tr(1000 + i)),
    ).bars;
    expect(ticks.map((b) => b.trades)).toEqual([10, 10, 5]);
  });

  it('session-aligned weekly and monthly bars use the session open day', () => {
    // session opens 14:30 UTC on weekdays; a trade at 02:00 belongs to the previous day's session
    const rules: SessionRules = {
      id: 'x',
      inSession: () => true,
      sessionStart(ts) {
        const d = new Date(ts);
        const open = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14, 30);
        return ts >= open ? open : open - DAY_MS;
      },
    };
    const monthly = BarSeries.build(
      { kind: 'time', ms: 30 * DAY_MS, cal: 'month' },
      [tr(utc(2024, 3, 1, 2)), tr(utc(2024, 3, 1, 15)), tr(utc(2024, 4, 1, 15))],
      rules,
    ).bars;
    // 2024-03-01 02:00 belongs to the 2024-02-29 session: February
    expect(monthly.map((b) => b.t)).toEqual([utc(2024, 2, 1), utc(2024, 3, 1), utc(2024, 4, 1)]);
    const weekly = BarSeries.build(
      { kind: 'time', ms: WEEK_MS },
      [tr(utc(2024, 5, 13, 2)), tr(utc(2024, 5, 13, 15)), tr(utc(2024, 5, 14, 15))],
      rules,
    ).bars;
    // Monday 02:00 belongs to Sunday's session (the Sunday-evening open rolls into the new week)
    expect(weekly.map((b) => b.t)).toEqual([utc(2024, 5, 13)]);
  });
});
