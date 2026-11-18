import { describe, expect, it } from 'vitest';
import type { Bar } from '@htflow/market-data';
import { alignAuxClose, beta, pearson, ratioOf, simpleReturn, spreadOf } from './second';

const bar = (t: number, c: number) => ({ t, c }) as Bar;

describe('alignAuxClose', () => {
  it('forward-fills gaps and uses NaN before the first aux bar', () => {
    const host = [0, 60, 120, 180, 240].map((t) => bar(t, 1));
    const aux = [bar(60, 10), bar(180, 30)];
    const out = new Float64Array(5);
    alignAuxClose(host, aux, 0.5, 0, 5, out);
    expect(out[0]).toBeNaN();
    expect(Array.from(out.slice(1))).toEqual([5, 5, 15, 15]);
  });

  it('can fill a tail only', () => {
    const host = [0, 60, 120].map((t) => bar(t, 1));
    const aux = [bar(0, 2), bar(120, 4)];
    const out = new Float64Array([9, 9, 9]);
    alignAuxClose(host, aux, 1, 2, 3, out);
    expect(Array.from(out)).toEqual([9, 9, 4]);
  });
});

describe('statistics', () => {
  const x = [1, 2, 3, 4, 5];
  it('pearson of perfectly (anti)correlated series', () => {
    expect(
      pearson(
        x,
        x.map((v) => 2 * v + 1),
        4,
        5,
      ),
    ).toBeCloseTo(1, 12);
    expect(
      pearson(
        x,
        x.map((v) => -v),
        4,
        5,
      ),
    ).toBeCloseTo(-1, 12);
  });
  it('pearson matches a hand calculation', () => {
    // x = 1,2,3  y = 2,1,4: cov sum = 2, sxx = 2, syy = 14/3
    expect(pearson([1, 2, 3], [2, 1, 4], 2, 3)).toBeCloseTo(2 / Math.sqrt(2 * (14 / 3)), 10);
  });
  it('is NaN for a flat series, short windows and missing values', () => {
    expect(pearson(x, [1, 1, 1, 1, 1], 4, 5)).toBeNaN();
    expect(pearson(x, x, 4, 1)).toBeNaN();
    expect(pearson(x, x, 2, 5)).toBeNaN();
    expect(pearson([1, NaN, 3], [1, 2, 3], 2, 3)).toBeNaN();
  });
  it('beta of y = 2x + 1 on x is 2; of a flat benchmark is NaN', () => {
    expect(
      beta(
        x.map((v) => 2 * v + 1),
        x,
        4,
        5,
      ),
    ).toBeCloseTo(2, 12);
    expect(beta(x, [3, 3, 3, 3, 3], 4, 5)).toBeNaN();
  });
  it('rolling window only uses the last n values', () => {
    expect(pearson([9, 1, 2, 3], [0, 1, 2, 3], 3, 3)).toBeCloseTo(1, 12);
  });
  it('returns, spread and ratio', () => {
    expect(simpleReturn([100, 110], 1)).toBeCloseTo(0.1, 12);
    expect(simpleReturn([0, 110], 1)).toBeNaN();
    expect(simpleReturn([100], 0)).toBeNaN();
    expect(spreadOf(10, 4, 2)).toBe(2);
    expect(spreadOf(10, NaN)).toBeNaN();
    expect(ratioOf(10, 4)).toBe(2.5);
    expect(ratioOf(10, 0)).toBeNaN();
  });
});
