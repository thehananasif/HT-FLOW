import { describe, expect, it } from 'vitest';
import { imbalances, newCandle, pocOf, rng, SyntheticFlow, candleDelta } from './footprintSim';

describe('footprintSim', () => {
  it('poc is the level with the most volume', () => {
    const c = newCandle(1, 100);
    c.levels.set(100, { bid: 3, ask: 2 });
    c.levels.set(101, { bid: 20, ask: 30 });
    c.levels.set(102, { bid: 1, ask: 1 });
    expect(pocOf(c)).toBe(101);
    expect(pocOf(newCandle(2, 5))).toBeNull();
  });
  it('flags diagonal imbalances', () => {
    const c = newCandle(1, 100);
    c.levels.set(100, { bid: 2, ask: 1 });
    c.levels.set(101, { bid: 1, ask: 12 }); // ask 12 vs bid 2 below -> ask imbalance
    c.levels.set(102, { bid: 1, ask: 1 });
    c.levels.set(103, { bid: 1, ask: 1 });
    const imb = imbalances(c);
    expect(imb.has('101:ask')).toBe(true);
    expect(imb.has('100:bid')).toBe(false);
    c.levels.set(104, { bid: 15, ask: 1 }); // bid 15 vs ask 0 above -> bid imbalance
    c.levels.set(105, { bid: 1, ask: 1 });
    expect(imbalances(c).has('104:bid')).toBe(true);
  });
  it('is deterministic and rolls candles', () => {
    const a = new SyntheticFlow(7);
    const b = new SyntheticFlow(7);
    a.prints(200);
    b.prints(200);
    expect(a.current.close).toBe(b.current.close);
    expect(candleDelta(a.current)).toBe(candleDelta(b.current));
    const first = a.roll();
    expect(first.closed).toBe(true);
    expect(a.current.open).toBe(first.close);
    expect(a.current.levels.size).toBe(0);
  });
  it('rng stays in [0,1)', () => {
    const r = rng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});
