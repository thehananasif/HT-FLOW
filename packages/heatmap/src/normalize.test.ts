import { describe, expect, it } from 'vitest';
import type { DepthColumn } from '@htflow/market-data';
import { columnCutoffs, cutoffsOf, globalCutoffs, percentileOf, SessionCutoffs } from './normalize';

const col = (t: number, levels: [number, number][]): DepthColumn => ({
  t,
  bestBid: 100,
  bestAsk: 101,
  pxs: Int32Array.from(levels.map((l) => l[0])),
  qtys: Float32Array.from(levels.map((l) => l[1])),
});

describe('normalisation', () => {
  it('percentileOf does not mutate its input', () => {
    const a = Float32Array.from([5, 1, 4, 2, 3]);
    expect(percentileOf(a, 0.5)).toBe(3);
    expect([...a]).toEqual([5, 1, 4, 2, 3]);
    expect(percentileOf([], 0.5)).toBe(0);
  });
  it('cut-offs follow the lower / upper percentages', () => {
    const v = Array.from({ length: 101 }, (_, i) => i);
    expect(cutoffsOf(v, 20, 98)).toEqual({ lo: 20, hi: 98 });
    // Swapped inputs are tolerated.
    expect(cutoffsOf(v, 98, 20)).toEqual({ lo: 20, hi: 98 });
  });
  it('never returns an empty range', () => {
    const c = cutoffsOf([5, 5, 5], 20, 98);
    expect(c.hi).toBeGreaterThan(c.lo);
  });
  it('lower 0 % keeps the smallest size visible', () => {
    expect(cutoffsOf([3, 4, 5], 0, 100).lo).toBe(0);
  });
  it('per-column cut-offs differ for a thin and a busy column', () => {
    const thin = col(1, [
      [95, 1],
      [96, 2],
      [97, 3],
      [98, 4],
    ]);
    const busy = col(2, [
      [95, 100],
      [96, 200],
      [97, 300],
      [98, 400],
    ]);
    const a = columnCutoffs(thin, 0, 100);
    const b = columnCutoffs(busy, 0, 100);
    expect(a.hi).toBe(4);
    expect(b.hi).toBe(400);
    // Cached per column + percentages.
    expect(columnCutoffs(thin, 0, 100)).toBe(a);
    expect(columnCutoffs(thin, 10, 100)).not.toBe(a);
  });
  it('global cut-offs only sample the visible window and price range', () => {
    const cols = [
      col(1, [[100, 1000]]),
      col(2, [
        [100, 10],
        [200, 5000],
      ]),
      col(3, [[100, 20]]),
    ];
    const visible = globalCutoffs(cols, 1, 2, 0, 100, [50, 150]);
    expect(visible.hi).toBe(20);
    const all = globalCutoffs(cols, 0, 2, 0, 100, null);
    expect(all.hi).toBe(5000);
  });
  it('session cut-offs are cached until enough new columns arrive', () => {
    const s = new SessionCutoffs();
    const cols = [col(1, [[100, 10]]), col(2, [[100, 30]])];
    const a = s.get(cols, 0, 100);
    expect(a.hi).toBe(30);
    expect(s.get(cols, 0, 100)).toBe(a);
  });
});
