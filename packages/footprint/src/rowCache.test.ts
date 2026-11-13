import { describe, expect, it } from 'vitest';
import { BarSeries, type Trade } from '@htflow/market-data';
import { RowCache, mergeRows } from './merge';
import { rgba } from './footprintLayer';

const tr = (ts: number, px: number, qty: number, side: Trade['side'], id: number): Trade => ({
  ts,
  px,
  qty,
  side,
  id,
});

describe('RowCache (P29 hot-path memo)', () => {
  it('returns the same rows as mergeRows and reuses them while the bar is unchanged', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, [
      tr(0, 100, 2, 'buy', 1),
      tr(1, 101, 3, 'sell', 2),
      tr(2, 103, 1, 'buy', 3),
    ]);
    const bar = s.bars[0]!;
    const cache = new RowCache();
    for (const rt of [1, 2, 4]) {
      const a = cache.rows(bar, rt);
      expect(a).toEqual(mergeRows(bar, rt));
      expect(cache.rows(bar, rt)).toBe(a);
    }
  });

  it('rebuilds when the live bar receives a trade', () => {
    const s = new BarSeries({ kind: 'time', ms: 60_000 });
    s.add(tr(0, 100, 2, 'buy', 1));
    const cache = new RowCache();
    const before = cache.rows(s.bars[0]!, 1);
    s.add(tr(1, 100, 1, 'sell', 2));
    const after = cache.rows(s.bars[0]!, 1);
    expect(after).not.toBe(before);
    expect(after).toEqual(mergeRows(s.bars[0]!, 1));
    s.add(tr(2, 105, 1, 'buy', 3));
    expect(cache.rows(s.bars[0]!, 1)).toHaveLength(2);
  });
});

describe('rgba', () => {
  it('formats hex colours with alpha (cached parse gives identical strings)', () => {
    expect(rgba('#FF8000', 0.5)).toBe('rgba(255,128,0,0.5)');
    expect(rgba('#FF8000', 1)).toBe('rgba(255,128,0,1)');
    expect(rgba('#0a0b0c', 0.25)).toBe('rgba(10,11,12,0.25)');
  });
});
