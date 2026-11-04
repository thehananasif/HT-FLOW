import { describe, expect, it } from 'vitest';
import { BarSeries, type Trade } from '@htflow/market-data';
import { diagonalImbalances, mergeRows, stackedZones } from './merge';

const tr = (px: number, qty: number, side: 'buy' | 'sell', i: number): Trade => ({
  ts: i,
  px,
  qty,
  side,
  id: i,
});

describe('footprint rows', () => {
  // Hand-computed dataset: price 103..100
  const trades = [
    tr(103, 9, 'buy', 1),
    tr(103, 1, 'sell', 2),
    tr(102, 12, 'buy', 3),
    tr(102, 2, 'sell', 4),
    tr(101, 10, 'buy', 5),
    tr(101, 3, 'sell', 6),
    tr(100, 1, 'buy', 7),
    tr(100, 2, 'sell', 8),
  ];
  const bar = BarSeries.build({ kind: 'time', ms: 60_000 }, trades).bars[0]!;

  it('merges clusters into rows high → low', () => {
    const rows = mergeRows(bar, 1);
    expect(rows.map((r) => [r.px, r.bid, r.ask])).toEqual([
      [103, 1, 9],
      [102, 2, 12],
      [101, 3, 10],
      [100, 2, 1],
    ]);
    const merged = mergeRows(bar, 2);
    expect(merged.map((r) => [r.px, r.vol, r.delta])).toEqual([
      [102, 24, 18],
      [100, 16, 6],
    ]);
  });

  it('detects diagonal buy imbalances at 300% and stacked zones of 3', () => {
    const rows = mergeRows(bar, 1);
    const imb = diagonalImbalances(rows, 3, 1);
    // 103 ask 9 vs 102 bid 2 → 4.5x; 102 ask 12 vs 101 bid 3 → 4x; 101 ask 10 vs 100 bid 2 → 5x
    expect(imb.map((x) => x.buy)).toEqual([true, true, true, false]);
    expect(imb.map((x) => x.sell)).toEqual([false, false, false, false]);
    expect(stackedZones(rows, imb, 3)).toEqual([[101, 103, 'buy']]);
  });
});
