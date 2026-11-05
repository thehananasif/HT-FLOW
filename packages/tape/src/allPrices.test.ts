import { describe, expect, it } from 'vitest';
import type { Aggressor, Trade } from '@htflow/market-data';
import {
  PriceStatsAccumulator,
  TradeCursor,
  autoGrouping,
  groupLevels,
  lowerBoundTs,
  pocOf,
  priceStats,
  quoteAt,
  rangeStart,
  sessionStart,
  sortLevels,
  weekStart,
} from './allPrices';

let id = 1;
const tr = (ts: number, px: number, qty: number, side: Aggressor): Trade => ({
  ts,
  px,
  qty,
  side,
  id: id++,
});

describe('All Prices statistics', () => {
  const trades = [
    tr(0, 100, 2, 'buy'),
    tr(1000, 101, 3, 'sell'),
    tr(4000, 100, 5, 'sell'),
    tr(4500, 100, 1, 'unknown'),
    tr(6000, 102, 4, 'buy'),
  ];

  it('accumulates volume, bid/ask volume, delta, trades, time at price and last seen', () => {
    const { levels, poc, totalVolume, totalTrades } = priceStats(trades, 0, Infinity, 7000);
    const at = (px: number) => levels.find((l) => l.px === px)!;
    expect(at(100)).toEqual({
      px: 100,
      volume: 8,
      bidVol: 5,
      askVol: 2,
      delta: -3,
      trades: 3,
      timeMs: 1000 + 500 + 1500,
      lastSeen: 4500,
    });
    expect(at(101)).toMatchObject({ volume: 3, bidVol: 3, askVol: 0, delta: -3, timeMs: 3000 });
    // the last price keeps accruing time until "now"
    expect(at(102)).toMatchObject({ volume: 4, askVol: 4, delta: 4, timeMs: 1000, lastSeen: 6000 });
    expect(poc).toBe(100);
    expect(totalVolume).toBe(15);
    expect(totalTrades).toBe(5);
  });

  it('restricts to a time range', () => {
    const { levels, poc } = priceStats(trades, 1000, 4500);
    expect(levels.map((l) => [l.px, l.volume])).toEqual([
      [101, 3],
      [100, 5],
    ]);
    expect(poc).toBe(100);
  });

  it('caps time-at-price gaps', () => {
    const acc = new PriceStatsAccumulator(500);
    acc.addRange([tr(0, 10, 1, 'buy'), tr(10_000, 11, 1, 'buy')]);
    expect(acc.levels.get(10)!.timeMs).toBe(500);
  });

  it('POC ties resolve to the lower price; empty → NaN', () => {
    const acc = new PriceStatsAccumulator();
    acc.addRange([tr(0, 12, 2, 'buy'), tr(1, 11, 2, 'sell')]);
    expect(pocOf(acc.levels.values())).toBe(11);
    expect(pocOf([])).toBeNaN();
  });

  it('groups rows and sorts by any column', () => {
    const { levels } = priceStats(trades, 0);
    const g = groupLevels(levels, 2);
    expect(g.map((l) => [l.px, l.volume, l.delta]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [100, 11, -6],
      [102, 4, 4],
    ]);
    expect(sortLevels(g, 'volume', 'desc').map((l) => l.px)).toEqual([100, 102]);
    expect(sortLevels(g, 'px', 'asc').map((l) => l.px)).toEqual([100, 102]);
    expect(autoGrouping(50)).toBe(1);
    expect(autoGrouping(1000, 120)).toBe(10);
    expect(autoGrouping(1e9)).toBe(10000);
  });
});

describe('ranges', () => {
  const t = Date.UTC(2026, 10, 4, 15, 30); // Wednesday 4 Nov 2026 15:30 UTC

  it('session starts at the configured UTC hour', () => {
    expect(sessionStart(t)).toBe(Date.UTC(2026, 10, 4));
    expect(sessionStart(t, 22)).toBe(Date.UTC(2026, 10, 3, 22));
    expect(sessionStart(Date.UTC(2026, 10, 4, 23), 22)).toBe(Date.UTC(2026, 10, 4, 22));
  });

  it('week starts on Monday', () => {
    expect(weekStart(t)).toBe(Date.UTC(2026, 10, 2));
    expect(weekStart(Date.UTC(2026, 10, 2, 0, 0, 1))).toBe(Date.UTC(2026, 10, 2));
    expect(weekStart(Date.UTC(2026, 10, 8, 23))).toBe(Date.UTC(2026, 10, 2));
  });

  it('visible = rolling window', () => {
    expect(rangeStart('visible', t, { sessionStartHourUtc: 0, visibleMs: 1_800_000 })).toBe(
      t - 1_800_000,
    );
    expect(rangeStart('session', t)).toBe(Date.UTC(2026, 10, 4));
    expect(rangeStart('week', t)).toBe(Date.UTC(2026, 10, 2));
  });
});

describe('helpers', () => {
  it('quoteAt finds the newest depth column at or before ts', () => {
    const cols = [
      { t: 0, bestBid: 9, bestAsk: 10 },
      { t: 250, bestBid: 10, bestAsk: 11 },
    ];
    expect(quoteAt(cols, 100)).toEqual([9, 10]);
    expect(quoteAt(cols, 250)).toEqual([10, 11]);
    expect(quoteAt(cols, -1)).toEqual([NaN, NaN]);
    expect(quoteAt(cols, 10_000)).toEqual([NaN, NaN]);
  });

  it('TradeCursor yields only new trades and resyncs when the array is replaced', () => {
    const a = [tr(1, 1, 1, 'buy'), tr(2, 1, 1, 'buy')];
    const c = new TradeCursor();
    expect(c.next(a)).toEqual([0, 2]);
    a.push(tr(3, 1, 1, 'buy'));
    expect(c.next(a)).toEqual([2, 3]);
    expect(c.next(a)).toEqual([3, 3]);
    const trimmed = [a[1]!, a[2]!, tr(4, 1, 1, 'buy')];
    expect(c.next(trimmed)).toEqual([2, 3]);
    c.seek(trimmed, 3);
    expect(c.next(trimmed)).toEqual([1, 3]);
    expect(lowerBoundTs(trimmed, 2.5)).toBe(1);
  });
});
