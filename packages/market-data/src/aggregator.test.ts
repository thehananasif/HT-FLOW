import { describe, expect, it } from 'vitest';
import { BarSeries, TIMEFRAME_PRESETS, type BarSpec } from './aggregator';
import { MockFeed } from './mockFeed';
import type { Trade } from './types';

const t = (ts: number, px: number, qty: number, side: 'buy' | 'sell'): Trade => ({
  ts,
  px,
  qty,
  side,
  id: ts,
});

describe('BarSeries', () => {
  it('builds time bars with clusters, delta and OHLC', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, [
      t(0, 100, 2, 'buy'),
      t(10_000, 101, 3, 'sell'),
      t(20_000, 99, 1, 'buy'),
      t(60_000, 102, 4, 'buy'),
    ]);
    expect(s.bars).toHaveLength(2);
    const b = s.bars[0]!;
    expect([b.o, b.h, b.l, b.c]).toEqual([100, 101, 99, 99]);
    expect(b.vol).toBe(6);
    expect(b.delta).toBe(0);
    expect(b.minDelta).toBe(-1);
    expect(b.maxDelta).toBe(2);
    expect(b.clusters.get(101)).toMatchObject({ bid: 3, ask: 0, trades: 1 });
    expect(b.closed).toBe(true);
    expect(s.bars[1]!.t).toBe(60_000);
  });

  it('closes tick, volume, delta and range bars at their thresholds', () => {
    const trades = [
      t(1, 10, 1, 'buy'),
      t(2, 11, 1, 'buy'),
      t(3, 12, 1, 'buy'),
      t(4, 15, 1, 'sell'),
    ];
    expect(BarSeries.build({ kind: 'tick', n: 2 }, trades).bars).toHaveLength(2);
    expect(BarSeries.build({ kind: 'volume', n: 3 }, trades).bars.map((b) => b.vol)).toEqual([
      3, 1,
    ]);
    expect(BarSeries.build({ kind: 'delta', n: 2 }, trades).bars.map((b) => b.delta)).toEqual([
      2, 0,
    ]);
    const r = BarSeries.build({ kind: 'range', ticks: 2 }, trades);
    expect(r.bars.map((b) => [b.l, b.h])).toEqual([
      [10, 12],
      [15, 15],
    ]);
  });

  it('bulk and incremental builds are identical for every preset bar type', () => {
    const feed = new MockFeed('CLZ6', {
      seed: 7,
      historyHours: 1,
      depthMinutes: 1,
      now: 1_700_000_000_000,
    });
    const { trades } = feed.historySync();
    expect(trades.length).toBeGreaterThan(1000);
    const specs: BarSpec[] = TIMEFRAME_PRESETS.flatMap((r) => r.specs);
    for (const spec of specs) {
      const bulk = BarSeries.build(spec, trades);
      const inc = new BarSeries(spec);
      for (let i = 0; i < trades.length; i += 37) inc.addAll(trades.slice(i, i + 37));
      expect(inc.bars.length).toBe(bulk.bars.length);
      const totalVol = trades.reduce((a, x) => a + x.qty, 0);
      const barVol = bulk.bars.reduce((a, b) => a + b.vol, 0);
      expect(barVol).toBeCloseTo(totalVol, 6);
      expect(inc.bars.map((b) => [b.o, b.h, b.l, b.c, b.vol, b.delta])).toEqual(
        bulk.bars.map((b) => [b.o, b.h, b.l, b.c, b.vol, b.delta]),
      );
    }
  });

  it('finds bars by time', () => {
    const s = BarSeries.build({ kind: 'time', ms: 1000 }, [
      t(0, 1, 1, 'buy'),
      t(5000, 1, 1, 'buy'),
    ]);
    expect(s.indexAt(4000)).toBe(0);
    expect(s.indexAt(5500)).toBe(1);
  });
});
