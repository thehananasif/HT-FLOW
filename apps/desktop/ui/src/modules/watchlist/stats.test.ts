import { describe, expect, it } from 'vitest';
import { moveItem, RowStats, sparkPoints, statsFrom } from './stats';

describe('watchlist RowStats', () => {
  it('accumulates last, change, volume, delta, vwap, high/low', () => {
    const s = new RowStats(1000, 4800, 48);
    s.add([
      { ts: 500, px: 1, qty: 99, side: 'buy' }, // before window: ignored
      { ts: 1000, px: 100, qty: 2, side: 'buy' },
      { ts: 1100, px: 102, qty: 1, side: 'sell' },
      { ts: 2000, px: 110, qty: 1, side: 'buy' },
    ]);
    expect(s.open).toBe(100);
    expect(s.last).toBe(110);
    expect(s.change).toBe(10);
    expect(s.changePct).toBeCloseTo(10);
    expect(s.volume).toBe(4);
    expect(s.delta).toBe(2);
    expect(s.vwap).toBeCloseTo((200 + 102 + 110) / 4);
    expect([s.high, s.low]).toEqual([110, 100]);
    expect(s.spark()).toEqual([100, ...Array<number>(9).fill(102), 110]);
  });
  it('empty stats are NaN', () => {
    const s = new RowStats(0);
    expect(Number.isNaN(s.changePct)).toBe(true);
    expect(s.spark()).toEqual([]);
  });
  it('helpers', () => {
    expect(statsFrom(undefined, 100)).toBe(100);
    expect(statsFrom(0, 2 * 86_400_000)).toBe(86_400_000);
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(sparkPoints([1, 2], 10, 10)).toBe('0.0,9.0 10.0,1.0');
    expect(sparkPoints([1], 10, 10)).toBe('');
  });
});
