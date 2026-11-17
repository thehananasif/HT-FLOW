import { describe, expect, it } from 'vitest';
import type { AccountSnapshot, AuxBars, Level, Zone } from '@htflow/indicator-sdk';
import { accountEquity, positionPnl, positionSize } from './account';
import { pnlSegments } from './optionsPos';
import { items, mkBars, run, vals } from './testkit';

const host = mkBars([100, 102, 101, 105, 104, 108, 107, 110]);
const auxClose = [50, 51, 50, 53, 52, 54, 53, 55];
const auxBars = (tick = 1): AuxBars => ({ bars: mkBars(auxClose), version: 1, tickSize: tick });
const aux = (b: AuxBars | null) => (id: string) => (id === 'X:AUX' ? b : null);

describe('second-instrument indicators', () => {
  it('Spread = C - k*C2 in ticks of the chart', () => {
    const rt = run(
      'spread',
      host,
      { symbol: 'X:AUX', k: 2 },
      { tickSize: 0.5, aux: aux(auxBars()) },
    );
    // real host = 100 * 0.5 = 50; aux = 50; 50 - 2 * 50 = -50 -> / 0.5 = -100 ticks
    expect(vals(rt, 'spread')[0]).toBeCloseTo(-100, 9);
    expect(vals(rt, 'spread')[7]).toBeCloseTo((110 * 0.5 - 2 * 55) / 0.5, 9);
  });

  it('Spread percent mode and Ratio', () => {
    const p = run('spread', host, { symbol: 'X:AUX', mode: 'percent' }, { aux: aux(auxBars()) });
    expect(vals(p, 'spread')[0]).toBeCloseTo(100, 9);
    const r = run('ratio', host, { symbol: 'X:AUX' }, { aux: aux(auxBars()) });
    expect(vals(r, 'ratio')[3]).toBeCloseTo(105 / 53, 12);
  });

  it('uses the aux instrument tick size for real prices', () => {
    const r = run('ratio', host, { symbol: 'X:AUX' }, { aux: aux(auxBars(2)) });
    expect(vals(r, 'ratio')[0]).toBeCloseTo(100 / 100, 12);
  });

  it('Correlation of returns is +1 for identical moves and the length decides the warm-up', () => {
    const same = { bars: mkBars(host.map((b) => b.c)), version: 1, tickSize: 1 };
    const rt = run('correlation', host, { symbol: 'X:AUX', length: 4 }, { aux: aux(same) });
    const v = vals(rt, 'corr');
    expect(v.slice(0, 4).every(Number.isNaN)).toBe(true); // 4 returns need bar 4
    expect(v[4]).toBeCloseTo(1, 9);
    expect(v[7]).toBeCloseTo(1, 9);
  });

  it('Beta of a series that moves twice as much as the benchmark', () => {
    const b = [100, 101, 102.01, 100.9699, 103.99, 105, 104, 106];
    const bench = { bars: mkBars(b), version: 1, tickSize: 1 };
    const a = [100];
    for (let i = 1; i < b.length; i++) a.push(a[i - 1]! * (1 + 2 * (b[i]! / b[i - 1]! - 1)));
    const rt = run('beta', mkBars(a), { symbol: 'X:AUX', length: 5 }, { aux: aux(bench) });
    expect(vals(rt, 'beta')[7]).toBeCloseTo(2, 6);
  });

  it('shows a note and no values without an instrument or data', () => {
    const none = run('spread', host, { symbol: '' });
    expect(none.notice).toMatch(/pick a second/);
    expect(vals(none, 'spread').every(Number.isNaN)).toBe(true);
    const wait = run('ratio', host, { symbol: 'X:AUX' }, { aux: aux(null) });
    expect(wait.notice).toMatch(/waiting for AUX/);
  });

  it('gaps in the second instrument keep the last value', () => {
    const gappy = {
      bars: [host[0]!, host[4]!].map((b, k) => ({ ...b, c: k ? 60 : 50 })),
      version: 1,
      tickSize: 1,
    };
    const r = run('ratio', host, { symbol: 'X:AUX' }, { aux: aux(gappy) });
    expect(vals(r, 'ratio')[2]).toBeCloseTo(101 / 50, 12);
    expect(vals(r, 'ratio')[5]).toBeCloseTo(108 / 60, 12);
  });
});

const snap = (o: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  version: 1,
  name: 'Paper',
  currency: 'USD',
  startingBalance: 50_000,
  balance: 50_000,
  positionQty: 0,
  avgPx: 0,
  pnlPerTick: 12.5,
  otherUnrealized: 0,
  openPositions: 0,
  ...o,
});

describe('account indicators', () => {
  it('position pnl and equity', () => {
    const a = snap({ positionQty: -2, avgPx: 100, otherUnrealized: 30 });
    expect(positionPnl(a, 96)).toBeCloseTo(100, 9); // short 2, +4 ticks x 12.5 x 2
    expect(accountEquity(a, 96)).toBeCloseTo(50_130, 9);
    expect(positionPnl(snap(), 96)).toBe(0);
  });

  it('fixed-fractional sizing', () => {
    expect(positionSize(50_000, 1, 20, 12.5)).toEqual({ budget: 500, riskPerUnit: 250, units: 2 });
    expect(positionSize(50_000, 1, 0, 12.5).units).toBe(0);
    expect(positionSize(-5, 1, 10, 1).units).toBe(0);
  });

  it('Account Info Display shows balance / equity on the last bar', () => {
    const a = snap({ positionQty: 1, avgPx: 100, openPositions: 1 });
    const rt = run('account-info', host, {}, { account: () => a });
    expect(vals(rt, 'balance')[7]).toBe(50_000);
    expect(vals(rt, 'equity')[7]).toBeCloseTo(50_000 + 10 * 12.5, 9);
    expect(vals(rt, 'balance')[3]).toBeNaN();
    expect(rt.notice).toMatch(/Paper · balance 50,000\.00 USD/);
    expect(run('account-info', host).notice).toBe('no trading account');
  });

  it('Position Sizing Tracker', () => {
    const a = snap({ positionQty: 3 });
    const rt = run(
      'position-sizing',
      host,
      { risk: 1, stop: 20, base: 'balance' },
      { account: () => a },
    );
    expect(vals(rt, 'size')[7]).toBe(2);
    expect(vals(rt, 'open')[7]).toBe(3);
    expect(rt.notice).toMatch(/→ 2 units/);
  });
});

describe('options indicators (paper options)', () => {
  const T = Date.UTC(2026, 0, 1);
  const bars = mkBars([100, 100, 100], { t0: T });
  const opt = (o: object) => ({
    id: 'o1',
    right: 'call' as const,
    strike: 100,
    expiry: '2026-03-01',
    qty: 1,
    avgPremium: 5,
    multiplier: 1,
    iv: 0.5,
    ...o,
  });

  it('draws strike levels and a break-even for a long call', () => {
    const rt = run('options-position', bars, {}, { account: () => snap({ options: [opt({})] }) });
    const lv = items<Level>(rt, 'levels');
    expect(lv.find((l) => l.tone === 0)?.value).toBe(100);
    expect(lv.find((l) => l.tone === 2)!.value).toBeCloseTo(105, 1);
    expect(rt.notice).toMatch(/1 option leg/);
  });

  it('Risk Profile builds a loss zone below and a profit zone above the break-even', () => {
    const rt = run(
      'options-risk-profile',
      bars,
      {},
      { account: () => snap({ options: [opt({})] }) },
    );
    const z = items<Zone>(rt, 'zones');
    expect(z.length).toBe(2);
    expect(z.find((s) => s.tone === 1)!.top).toBeCloseTo(105, 0);
    expect(z.find((s) => s.tone === 0)!.bottom).toBeCloseTo(105, 0);
  });

  it('says so with no positions or only expired ones', () => {
    const none = run('options-position', bars, {}, { account: () => snap() });
    expect(none.notice).toMatch(/no open option/);
    const exp = snap({ options: [opt({ expiry: '2025-01-01' })] });
    expect(run('options-position', bars, {}, { account: () => exp }).notice).toMatch(
      /no open option/,
    );
  });

  it('pnlSegments splits at the zero crossing', () => {
    expect(pnlSegments([0, 10, 20], [-10, -10, 10])).toEqual([
      { from: 0, to: 15, profit: false },
      { from: 15, to: 20, profit: true },
    ]);
  });
});
