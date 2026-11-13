import { describe, expect, it } from 'vitest';
import { BarSeries, type Trade } from '@htflow/market-data';
import {
  absorptionRows,
  diagonalImbalances,
  horizontalImbalances,
  imbalances,
  mergeRows,
  passesFilter,
  stackedZones,
  valueAreaRows,
} from './merge';

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

  it('detects horizontal imbalances on the same row', () => {
    const rows = mergeRows(bar, 1);
    // 103: 9 vs 1 → buy; 102: 12 vs 2 → buy; 101: 10 vs 3 → buy (3.33x); 100: bid 2 vs ask 1 → 2x
    const h = horizontalImbalances(rows, 3, 0);
    expect(h.map((x) => x.buy)).toEqual([true, true, true, false]);
    expect(h.map((x) => x.sell)).toEqual([false, false, false, false]);
    expect(imbalances(rows, 'horizontal', 2, 0).map((x) => x.sell)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // Min volume filter: 9 < 10 drops the 103 row.
    expect(horizontalImbalances(rows, 3, 10).map((x) => x.buy)).toEqual([false, true, true, false]);
  });

  it('computes the value area per bar around the POC', () => {
    const rows = mergeRows(bar, 1); // vols 10, 14, 13, 3 → total 40
    expect(valueAreaRows(rows, 0.7)).toEqual({ hi: 0, lo: 2, poc: 1 }); // 14 + 13 = 27 < 28 → + 10
    expect(valueAreaRows(rows, 0.3)).toEqual({ hi: 1, lo: 1, poc: 1 });
    expect(valueAreaRows([], 0.7)).toBeNull();
  });

  it('filters cells by min volume and min delta, and finds absorption', () => {
    const rows = mergeRows(bar, 1);
    expect(rows.filter((r) => passesFilter(r, 11, 0)).map((r) => r.px)).toEqual([102, 101]);
    expect(rows.filter((r) => passesFilter(r, 0, 8)).map((r) => r.px)).toEqual([103, 102]);
    // avg 10; the 103 high row (10) is not ≥ 1.5 × avg, the 100 low row (3) neither.
    expect(absorptionRows(rows, 1.5)).toEqual([]);
    expect(absorptionRows(rows, 0.9)).toEqual([0]);
  });
});
