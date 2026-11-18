import { describe, expect, it } from 'vitest';
import { COT_RELEASE_LAG_MS, type CotData, type CotWeekData } from '@htflow/indicator-sdk';
import { N, mkBars, run, vals } from './testkit';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 6); // a Tuesday

const week = (k: number, comm: number, spec: number, small: number, oi = 1000): CotWeekData => ({
  t: T0 + k * 7 * DAY,
  openInterest: oi,
  groups: [
    { key: 'commercial', label: 'C', long: 0, short: 0, net: comm, netChange: k ? 10 : 0 },
    { key: 'noncommercial', label: 'NC', long: 0, short: 0, net: spec, netChange: k ? -5 : 0 },
    { key: 'nonreportable', label: 'S', long: 0, short: 0, net: small, netChange: 0 },
  ],
});

const cot: CotData = {
  version: 1,
  report: 'legacy',
  market: '13874A',
  weeks: [week(0, -100, 50, 10), week(1, -120, 80, 5), week(2, -90, 20, 7)],
};

/** One bar per day from the first Tuesday, so release moments can be probed exactly. */
const bars = mkBars(Array(30).fill(100), { t0: T0, ms: DAY });
const idxAtOrAfter = (ms: number) => Math.ceil((ms - T0) / DAY);

describe('COT indicators', () => {
  it('release lag: a week is invisible until its Friday 20:30 UTC publication', () => {
    const v = vals(run('cot', bars, {}, { cot }), 'specs');
    // The bar that starts on Friday 00:00 (day 3) is still before 20:30 -> nothing yet.
    expect(v[3]).toBeNaN();
    // The first bar starting at/after the release (Saturday, day 4) shows week 0.
    expect(v[idxAtOrAfter(T0 + COT_RELEASE_LAG_MS)]).toBe(50);
    // Week 1 is published a week later; before that the value holds (step).
    expect(v[idxAtOrAfter(T0 + COT_RELEASE_LAG_MS + 6 * DAY)]).toBe(50);
    expect(v[idxAtOrAfter(T0 + COT_RELEASE_LAG_MS + 7 * DAY)]).toBe(80);
  });

  it('COT: hedgers / speculators / small traders, optionally as % of open interest', () => {
    const rt = run('cot', bars, { asPct: true }, { cot });
    const i = idxAtOrAfter(T0 + COT_RELEASE_LAG_MS);
    expect(vals(rt, 'hedgers')[i]).toBeCloseTo(-10);
    expect(vals(rt, 'specs')[i]).toBeCloseTo(5);
    expect(vals(rt, 'small')[i]).toBeCloseTo(1);
  });

  it('Commercials / Non-Commercials: two lines and their difference', () => {
    const rt = run('cot-comm-noncomm', bars, {}, { cot });
    const i = idxAtOrAfter(T0 + COT_RELEASE_LAG_MS);
    expect(vals(rt, 'comm')[i]).toBe(-100);
    expect(vals(rt, 'noncomm')[i]).toBe(50);
    expect(vals(rt, 'diff')[i]).toBe(150);
  });

  it('Institutional: net and weekly change (first non-commercial category as fallback)', () => {
    const rt = run('cot-institutional', bars, {}, { cot });
    const i = idxAtOrAfter(T0 + COT_RELEASE_LAG_MS + 7 * DAY);
    expect(vals(rt, 'net')[i]).toBe(80);
    expect(vals(rt, 'chg')[i]).toBe(-5);
  });

  it('High/Low: window extremes of the speculators net, and the 0-100 index', () => {
    const last = idxAtOrAfter(T0 + COT_RELEASE_LAG_MS + 14 * DAY);
    const rt = run('cot-high-low', bars, { weeks: 52 }, { cot });
    expect(vals(rt, 'net')[last]).toBe(20);
    expect(vals(rt, 'high')[last]).toBe(80);
    expect(vals(rt, 'low')[last]).toBe(20);
    const idx = run('cot-high-low', bars, { weeks: 52, showIndex: true }, { cot });
    expect(vals(idx, 'net')[last]).toBe(0);
    expect(vals(idx, 'high')[last]).toBe(100);
    // window of 2 weeks drops week 0 (net 50): low stays 20, high 80
    const w2 = run('cot-high-low', bars, { weeks: 2 }, { cot });
    expect(vals(w2, 'high')[last]).toBe(80);
  });

  it('no COT feed: empty output and the "no data" notice', () => {
    const rt = run('cot', bars, {});
    expect(vals(rt, 'specs').every(Number.isNaN)).toBe(true);
    expect(rt.notice).toBe('no data from this feed');
    expect(N).toBeNaN();
  });
});
