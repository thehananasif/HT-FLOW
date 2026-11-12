import { describe, expect, it } from 'vitest';
import type { Trade } from '@htflow/market-data';
import {
  aggregateBubbles,
  bubbleAt,
  bubbleRadius,
  bubbleSummary,
  slotOfTrades,
  slotVolumes,
} from './bubbles';

let id = 1;
const tr = (ts: number, px: number, qty: number, side: 'buy' | 'sell'): Trade => ({
  ts,
  px,
  qty,
  side,
  id: id++,
});
const times = [1000, 1250, 1500, 1750];
const timeAt = (i: number) => times[i];

describe('trade bubbles', () => {
  it('assigns each trade to the last column at or before it', () => {
    const t = [
      tr(900, 1, 1, 'buy'),
      tr(1000, 1, 1, 'buy'),
      tr(1300, 1, 1, 'buy'),
      tr(1800, 1, 1, 'buy'),
    ];
    expect([...slotOfTrades(t, timeAt, 0, 3)]).toEqual([-1, 0, 1, 3]);
  });
  it('aggregates per column and price, with buy / sell split', () => {
    const t = [tr(1010, 100, 3, 'buy'), tr(1020, 100, 1, 'sell'), tr(1030, 102, 5, 'sell')];
    const b = aggregateBubbles(t, slotOfTrades(t, timeAt, 0, 3), {
      clustering: 0,
      calc: 'volume',
      minSize: 0,
    });
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ slot: 0, px: 100, buy: 3, sell: 1, trades: 2, size: 4 });
    expect(b[1]).toMatchObject({ px: 102, sell: 5, size: 5 });
  });
  it('clustering merges nearby prices and times', () => {
    const t = [tr(1010, 100, 3, 'buy'), tr(1020, 101, 1, 'sell'), tr(1260, 100, 2, 'buy')];
    const slots = slotOfTrades(t, timeAt, 0, 3);
    const none = aggregateBubbles(t, slots, { clustering: 0, calc: 'volume', minSize: 0 });
    expect(none).toHaveLength(3);
    const c3 = aggregateBubbles(t, slots, { clustering: 3, calc: 'volume', minSize: 0 });
    expect(c3).toHaveLength(1);
    expect(c3[0]).toMatchObject({ buy: 5, sell: 1, trades: 3, slot: 0 });
    expect(c3[0]!.px).toBeCloseTo((100 * 3 + 101 + 100 * 2) / 6, 6);
  });
  it('delta calc sizes by |buy − sell| and filters small bubbles', () => {
    const t = [tr(1010, 100, 3, 'buy'), tr(1020, 100, 3, 'sell'), tr(1300, 105, 4, 'buy')];
    const b = aggregateBubbles(t, slotOfTrades(t, timeAt, 0, 3), {
      clustering: 0,
      calc: 'delta',
      minSize: 1,
    });
    expect(b).toHaveLength(1);
    expect(b[0]!.size).toBe(4);
  });
  it('summarises a bubble for the tooltip', () => {
    const s = bubbleSummary({
      slot: 0,
      t: 0,
      last: 0,
      px: 0,
      buy: 61,
      sell: 123,
      trades: 18,
      size: 184,
    });
    expect(s).toEqual({
      vol: 184,
      buy: 61,
      sell: 123,
      buyPct: 33,
      sellPct: 67,
      trades: 18,
      side: 'BID',
    });
  });
  it('hit-tests the smallest bubble under the pointer', () => {
    const b = { slot: 0, t: 0, last: 0, px: 0, buy: 1, sell: 0, trades: 1, size: 1 };
    const big = { b, x: 50, y: 50, r: 20 };
    const small = { b, x: 55, y: 50, r: 5 };
    expect(bubbleAt([big, small], 55, 50)).toBe(small);
    expect(bubbleAt([big, small], 40, 50)).toBe(big);
    expect(bubbleAt([big, small], 100, 100)).toBeNull();
  });
  it('radius grows with size and the Size setting', () => {
    expect(bubbleRadius(100, 100, 100)).toBeGreaterThan(bubbleRadius(100, 100, 10));
    expect(bubbleRadius(25, 100, 50)).toBeCloseTo(bubbleRadius(100, 100, 50) / 2, 6);
    expect(bubbleRadius(0, 100, 50)).toBe(2.5);
  });
  it('volume bars sum buy and sell per column', () => {
    const t = [tr(1010, 100, 3, 'buy'), tr(1020, 100, 2, 'sell'), tr(1600, 100, 4, 'sell')];
    const v = slotVolumes(t, slotOfTrades(t, timeAt, 0, 3), 0, 3);
    expect([...v.buy]).toEqual([3, 0, 0, 0]);
    expect([...v.sell]).toEqual([2, 0, 4, 0]);
  });
});
