import { describe, expect, it } from 'vitest';
import { BarSeries } from './aggregator';
import { buildTpo } from './tpo';
import type { Trade } from './types';

const P = 30 * 60_000;
const t = (ts: number, px: number): Trade => ({ ts, px, qty: 1, side: 'buy', id: ts });

describe('buildTpo', () => {
  // A: 10..14, B: 12..16, C: 15, D: 11..13
  const trades = [
    t(0, 10),
    t(1, 14),
    t(P, 12),
    t(P + 1, 16),
    t(2 * P, 15),
    t(3 * P, 13),
    t(3 * P + 1, 11),
  ];
  const bars = BarSeries.build({ kind: 'time', ms: P }, trades).bars;

  it('letters per period, POC, value area, initial balance and single prints', () => {
    const [p] = buildTpo(bars, { rowTicks: 1 });
    expect(p!.periods.map((x) => x.letter).join('')).toBe('ABCD');
    const letters = (r: number) =>
      p!.rows
        .get(r)!
        .map((i) => p!.periods[i]!.letter)
        .join('');
    expect([10, 11, 12, 13, 14, 15, 16].map(letters)).toEqual([
      'A',
      'AD',
      'ABD',
      'ABD',
      'AB',
      'BC',
      'B',
    ]);
    expect(p!.total).toBe(14);
    expect(p!.poc).toBe(13);
    expect([p!.val, p!.vah]).toEqual([12, 15]);
    expect([p!.ibLo, p!.ibHi]).toEqual([10, 16]);
    expect(p!.singles).toEqual([10, 16]);
    expect([p!.open, p!.close]).toEqual([10, 11]);
  });

  it('splits profiles by key and merges rows by row size', () => {
    const split = buildTpo(bars, { rowTicks: 1, profileKey: (x) => Math.floor(x / (2 * P)) });
    expect(split.map((p) => p.periods.length)).toEqual([2, 2]);
    const merged = buildTpo(bars, { rowTicks: 2 });
    expect([...merged[0]!.rows.keys()].sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  });
});
