import { describe, expect, it } from 'vitest';
import type { Aggressor, Trade } from '@htflow/market-data';
import {
  TapeBuffer,
  aggregatePrints,
  deltaOf,
  signedQty,
  DEFAULT_FILTER,
  filterPrints,
  isFilterActive,
  normalizeFilter,
  passes,
  passesRaw,
  autoThresholds,
  bigPrintThreshold,
  isBigPrint,
  quantile,
  sizeBucket,
  SpeedMeter,
} from './index';

let id = 1;
const tr = (ts: number, px: number, qty: number, side: Aggressor): Trade => ({
  ts,
  px,
  qty,
  side,
  id: id++,
});

describe('smart print reconstruction', () => {
  // A buy sweep through three levels at t=1000, a sell at the same time, then a lone buy.
  const trades = [
    tr(1000, 100, 2, 'buy'),
    tr(1000, 101, 3, 'buy'),
    tr(1000, 102, 5, 'buy'),
    tr(1000, 101, 1, 'sell'),
    tr(1010, 101, 4, 'sell'),
    tr(1030, 101, 2, 'sell'),
    tr(1200, 103, 1, 'buy'),
  ];

  it('merges fills with the same timestamp and aggressor', () => {
    const p = aggregatePrints(trades, { mode: 'timestamp', windowMs: 0 });
    expect(p.map((x) => [x.ts, x.side, x.qty, x.trades])).toEqual([
      [1000, 'buy', 10, 3],
      [1000, 'sell', 1, 1],
      [1010, 'sell', 4, 1],
      [1030, 'sell', 2, 1],
      [1200, 'buy', 1, 1],
    ]);
    const sweep = p[0]!;
    expect(sweep.pxFirst).toBe(100);
    expect(sweep.px).toBe(102);
    expect(sweep.pxLow).toBe(100);
    expect(sweep.pxHigh).toBe(102);
    expect(sweep.vwap).toBeCloseTo((200 + 303 + 510) / 10, 10);
  });

  it('merges same-side fills inside a time window when asked', () => {
    const p = aggregatePrints(trades, { mode: 'window', windowMs: 50 });
    expect(p.map((x) => [x.ts, x.tsEnd, x.side, x.qty])).toEqual([
      [1000, 1000, 'buy', 10],
      [1000, 1030, 'sell', 7],
      [1200, 1200, 'buy', 1],
    ]);
  });

  it('keeps every fill when aggregation is off', () => {
    expect(aggregatePrints(trades, { mode: 'none', windowMs: 0 })).toHaveLength(trades.length);
  });

  it('tracks cumulative delta per print', () => {
    const p = aggregatePrints(trades, { mode: 'timestamp', windowMs: 0 }, 100);
    expect(p.map((x) => x.cvd)).toEqual([110, 109, 105, 103, 104]);
    expect(deltaOf(trades)).toBe(4);
    expect(signedQty({ qty: 3, side: 'unknown' })).toBe(0);
  });

  it('ring buffer keeps the newest prints and reads newest-first', () => {
    const b = new TapeBuffer(4, { mode: 'none', windowMs: 0 });
    for (let i = 0; i < 10; i++) b.push(tr(i, 100 + i, 1, 'buy'), 99 + i, 100 + i);
    expect(b.capacity).toBe(4);
    expect(b.size).toBe(4);
    expect(b.total).toBe(10);
    expect([0, 1, 2, 3].map((k) => b.pxAt(k))).toEqual([109, 108, 107, 106]);
    expect(b.bidAt(0)).toBe(108);
    expect(b.askAt(0)).toBe(109);
    expect(b.cvdAt(0)).toBe(10);
    expect(b.sideAt(0)).toBe(1);
    expect(b.toArray().map((p) => p.px)).toEqual([106, 107, 108, 109]);
  });

  it('push reports whether a new print started', () => {
    const b = new TapeBuffer(8);
    expect(b.push(tr(5, 1, 1, 'buy'))).toBe(true);
    expect(b.push(tr(5, 2, 1, 'buy'))).toBe(false);
    expect(b.push(tr(5, 2, 1, 'sell'))).toBe(true);
    expect(b.tradesAt(1)).toBe(2);
  });

  it('absorbs 5,000 prints/sec for a minute quickly', () => {
    // Median of 3 runs with a loose ceiling (suites share the CPU); strict numbers: `pnpm bench`.
    const times: number[] = [];
    for (let r = 0; r < 3; r++) {
      const b = new TapeBuffer(65_536, { mode: 'timestamp', windowMs: 0 });
      const t0 = performance.now();
      for (let i = 0; i < 300_000; i++) {
        b.push({
          ts: i / 5,
          px: 1000 + (i % 7),
          qty: 1 + (i % 5),
          side: i % 3 ? 'buy' : 'sell',
          id: i,
        });
      }
      times.push(performance.now() - t0);
      expect(b.size).toBe(65_536);
    }
    expect(times.sort((a, b) => a - b)[1]!).toBeLessThan(1500);
  }, 30_000);
});

describe('filters', () => {
  const p = (qty: number, side: Aggressor, px: number) => ({ qty, side, px });

  it('normalizes persisted values', () => {
    expect(normalizeFilter({})).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter({ minSize: -3, maxSize: 'x', side: 'nope' })).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter({ minSize: 10, maxSize: 2, minPx: 50, maxPx: 40 })).toEqual({
      minSize: 2,
      maxSize: 10,
      side: 'all',
      minPx: 40,
      maxPx: 50,
    });
    expect(isFilterActive(DEFAULT_FILTER)).toBe(false);
    expect(isFilterActive(normalizeFilter({ side: 'buy' }))).toBe(true);
  });

  it('applies size, side and price bounds', () => {
    const f = normalizeFilter({ minSize: 2, maxSize: 5, side: 'buy', minPx: 100, maxPx: 110 });
    expect(passes(f, p(3, 'buy', 105))).toBe(true);
    expect(passes(f, p(1, 'buy', 105))).toBe(false);
    expect(passes(f, p(6, 'buy', 105))).toBe(false);
    expect(passes(f, p(3, 'sell', 105))).toBe(false);
    expect(passes(f, p(3, 'buy', 99))).toBe(false);
    expect(passes(f, p(3, 'buy', 111))).toBe(false);
    expect(passesRaw(normalizeFilter({ side: 'sell' }), 1, -1, 0)).toBe(true);
    expect(passesRaw(normalizeFilter({ side: 'sell' }), 1, 0, 0)).toBe(false);
    const list = [p(1, 'buy', 1), p(10, 'sell', 1), p(4, 'buy', 1)];
    expect(filterPrints(list, normalizeFilter({ minSize: 4 }))).toHaveLength(2);
  });
});

describe('size buckets and big prints', () => {
  it('buckets by ascending thresholds', () => {
    const th = [1, 5, 10];
    expect([0.5, 1, 4.9, 5, 10, 99].map((q) => sizeBucket(q, th))).toEqual([0, 1, 1, 2, 3, 3]);
  });

  it('derives thresholds from percentiles', () => {
    const sizes = Array.from({ length: 101 }, (_, i) => i); // 0..100
    expect(quantile(sizes, 0.5)).toBe(50);
    expect(quantile([], 0.5)).toBeNaN();
    expect(autoThresholds(sizes, [0.5, 0.9])).toEqual([50, 90]);
    // duplicates collapse
    expect(autoThresholds([1, 1, 1, 1], [0.5, 0.9])).toEqual([1]);
  });

  it('big-print threshold: user value wins, auto never below 2× median', () => {
    expect(bigPrintThreshold(7, [1, 2, 3])).toBe(7);
    expect(bigPrintThreshold(0, [])).toBe(Number.POSITIVE_INFINITY);
    expect(bigPrintThreshold(0, [2, 2, 2, 2])).toBe(4);
    const sizes = [...Array(99).fill(1), 50];
    expect(bigPrintThreshold(0, sizes)).toBe(2); // p99 = 1.49 < 2 × median
    expect(isBigPrint(50, bigPrintThreshold(0, sizes))).toBe(true);
    expect(isBigPrint(1, bigPrintThreshold(0, sizes))).toBe(false);
  });
});

describe('speed meter', () => {
  it('counts prints and volume in the trailing window', () => {
    const m = new SpeedMeter(1000, 100);
    for (let i = 0; i < 50; i++) m.add(10_000 + i * 20, 2); // 50 prints over 1 s
    const r = m.rate(10_999);
    expect(r.printsPerSec).toBe(50);
    expect(r.volPerSec).toBe(100);
    // half a second later only the second half is inside the window
    expect(m.rate(11_499).printsPerSec).toBe(25);
    expect(m.rate(20_000).printsPerSec).toBe(0);
  });

  it('reuses buckets after wrapping', () => {
    const m = new SpeedMeter(500, 100);
    m.add(0, 1);
    m.add(500, 1); // same slot, new bucket key
    expect(m.rate(500).printsPerSec).toBe(2);
    m.reset();
    expect(m.rate(500).printsPerSec).toBe(0);
  });
});
