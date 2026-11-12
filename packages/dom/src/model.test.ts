import { describe, expect, it } from 'vitest';
import { OrderBook, type Trade } from '@htflow/market-data';
import type { Order } from '@htflow/trading';
import { DomModel } from './model';
import { computeValueArea, cumulativeDepth } from './analytics';

const T0 = Date.UTC(2026, 10, 11, 14, 0, 0);
let tid = 0;
const tr = (ts: number, px: number, qty: number, side: 'buy' | 'sell'): Trade => ({
  ts,
  px,
  qty,
  side,
  id: ++tid,
});

function book(bids: [number, number][], asks: [number, number][]): OrderBook {
  const b = new OrderBook();
  b.applySnapshot({ ts: 0, bids, asks });
  return b;
}

describe('DomModel volume, delta, last size', () => {
  it('accumulates session and rolling-range volume, delta and last print', () => {
    const m = new DomModel({ rangeMs: 60_000 });
    const trades: Trade[] = [];
    const bk = book([[99, 10]], [[100, 10]]);
    trades.push(tr(T0, 100, 3, 'buy'), tr(T0 + 1, 100, 2, 'sell'), tr(T0 + 2, 99, 4, 'sell'));
    m.update(trades, bk, T0 + 10);
    expect(m.session.get(100)).toBe(5);
    expect(m.deltaAt(100)).toBe(1);
    expect(m.deltaAt(99)).toBe(-4);
    expect(m.lastPrint.get(100)).toMatchObject({ qty: 2, side: 'sell' });
    // Two minutes later the range scope has expired, the session has not.
    trades.push(tr(T0 + 120_000, 101, 1, 'buy'));
    m.update(trades, bk, T0 + 120_000);
    m.configure({ volumeScope: 'range' });
    expect(m.volume.get(100)).toBeUndefined();
    expect(m.volume.get(101)).toBe(1);
    m.configure({ volumeScope: 'session' });
    expect(m.volume.get(100)).toBe(5);
    // Recent executions expire after the recent window.
    expect(m.recentBuys.get(100)).toBeUndefined();
    expect(m.recentBuys.get(101)).toBe(1);
  });

  it('rebuilds the rolling range when its length grows', () => {
    const m = new DomModel({ rangeMs: 1_000 });
    const trades = [tr(T0, 100, 3, 'buy'), tr(T0 + 5_000, 101, 1, 'buy')];
    const bk = book([[99, 1]], [[100, 1]]);
    m.update(trades, bk, T0 + 5_000);
    m.configure({ volumeScope: 'range' });
    expect(m.volume.get(100)).toBeUndefined();
    m.configure({ rangeMs: 60_000 });
    m.update(trades, bk, T0 + 5_000);
    expect(m.volume.get(100)).toBe(3);
  });
});

describe('Iceberg detection', () => {
  it('marks a level that refills after being hit, with the hidden size', () => {
    const m = new DomModel({ icebergMinRefills: 2 });
    const trades: Trade[] = [];
    const bk = book([[99, 50]], [[100, 10]]);
    m.update(trades, bk, T0);
    // Buyers lift 10 at 100; the ask shows 10 again → refill #1.
    trades.push(tr(T0 + 100, 100, 10, 'buy'));
    m.update(trades, bk, T0 + 100);
    expect(m.iceberg('ask', 100)).toBeUndefined();
    expect(m.icebergs.ask.get(100)!.refills).toBe(1);
    // Again → refill #2 → iceberg.
    trades.push(tr(T0 + 200, 100, 8, 'buy'));
    m.update(trades, bk, T0 + 200);
    const ice = m.iceberg('ask', 100)!;
    expect(ice.refills).toBe(2);
    expect(ice.hidden).toBe(18);
    expect(ice.executed).toBe(18);
  });

  it('does not flag a level that is simply consumed', () => {
    const m = new DomModel();
    const trades: Trade[] = [];
    const bk = book([[99, 50]], [[100, 10]]);
    m.update(trades, bk, T0);
    trades.push(tr(T0 + 100, 100, 4, 'buy'));
    bk.applyDelta({ side: 'sell', px: 100, qty: 6 });
    m.update(trades, bk, T0 + 100);
    trades.push(tr(T0 + 200, 100, 6, 'buy'));
    bk.applyDelta({ side: 'sell', px: 100, qty: 0 });
    m.update(trades, bk, T0 + 200);
    expect(m.icebergs.ask.get(100)!.refills).toBe(0);
    expect(m.iceberg('ask', 100)).toBeUndefined();
    // No pulled flash either: the size left through fills.
    expect(m.flash('ask', 100)).toBeUndefined();
  });

  it('expires iceberg marks after inactivity', () => {
    const m = new DomModel({ icebergMinRefills: 1, icebergTtlMs: 1_000 });
    const trades: Trade[] = [];
    const bk = book([[99, 50]], [[100, 10]]);
    m.update(trades, bk, T0);
    trades.push(tr(T0 + 10, 100, 10, 'sell'));
    // Sell aggressor hits bids at 100? None there — no bid side refill at 100.
    m.update(trades, bk, T0 + 10);
    expect(m.iceberg('bid', 100)).toBeUndefined();
    trades.push(tr(T0 + 20, 99, 50, 'sell'));
    m.update(trades, bk, T0 + 20);
    expect(m.iceberg('bid', 99)).toBeDefined();
    m.update(trades, bk, T0 + 5_000);
    expect(m.iceberg('bid', 99)).toBeUndefined();
  });
});

describe('Pulled / stacked detection', () => {
  it('flashes pulled and stacked levels at or above the thresholds only', () => {
    const m = new DomModel({ pulledThreshold: 20, stackedThreshold: 30, flashMs: 500 });
    const trades: Trade[] = [];
    const bk = book(
      [
        [99, 50],
        [98, 50],
        [97, 50],
      ],
      [
        [100, 50],
        [101, 50],
      ],
    );
    m.update(trades, bk, T0);
    bk.applyDelta({ side: 'buy', px: 98, qty: 25 }); // −25 → pulled
    bk.applyDelta({ side: 'buy', px: 97, qty: 40 }); // −10 → below threshold
    bk.applyDelta({ side: 'sell', px: 101, qty: 85 }); // +35 → stacked
    bk.applyDelta({ side: 'sell', px: 100, qty: 70 }); // +20 → below stacked threshold
    m.update(trades, bk, T0 + 50);
    expect(m.flash('bid', 98)).toMatchObject({ kind: 'pulled', amount: -25 });
    expect(m.flash('bid', 97)).toBeUndefined();
    expect(m.flash('ask', 101)).toMatchObject({ kind: 'stacked', amount: 35 });
    expect(m.flash('ask', 100)).toBeUndefined();
    // Flashes fade after flashMs.
    m.update(trades, bk, T0 + 1_000);
    expect(m.flash('bid', 98)).toBeUndefined();
  });

  it('thresholds are configurable', () => {
    const m = new DomModel({ pulledThreshold: 5 });
    const bk = book([[99, 50]], [[100, 50]]);
    const none: Trade[] = [];
    m.update(none, bk, T0);
    bk.applyDelta({ side: 'buy', px: 99, qty: 44 });
    m.update(none, bk, T0 + 10);
    expect(m.flash('bid', 99)?.kind).toBe('pulled');
    m.configure({ pulledThreshold: 100 });
    bk.applyDelta({ side: 'buy', px: 99, qty: 1 });
    m.update(none, bk, T0 + 20);
    expect(m.flash('bid', 99)?.amount).toBe(-6);
  });
});

describe('Limit tracking', () => {
  const order = (id: string, side: 'buy' | 'sell', px: number, qty: number): Order => ({
    id,
    accountId: 'a',
    instrumentId: 'i',
    side,
    type: 'limit',
    qty,
    filled: 0,
    px,
    tif: 'GTC',
    reduceOnly: false,
    status: 'working',
    avgFillPx: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  it('aggregates working orders per price and tracks queue ahead', () => {
    const m = new DomModel();
    const trades: Trade[] = [];
    const bk = book([[99, 40]], [[100, 10]]);
    const os = [order('1', 'buy', 99, 2), order('2', 'buy', 99, 3)];
    m.update(trades, bk, T0, os);
    expect(m.limits.get(99)).toMatchObject({ buyQty: 5, count: 2, ahead: 40 });
    trades.push(tr(T0 + 10, 99, 15, 'sell'));
    bk.applyDelta({ side: 'buy', px: 99, qty: 25 });
    m.update(trades, bk, T0 + 10, os);
    expect(m.limits.get(99)!.ahead).toBe(25);
    // Cancel ahead of us shrinks the queue too.
    bk.applyDelta({ side: 'buy', px: 99, qty: 10 });
    m.update(trades, bk, T0 + 20, os);
    expect(m.limits.get(99)!.ahead).toBe(10);
    m.update(trades, bk, T0 + 30, []);
    expect(m.limits.size).toBe(0);
  });
});

describe('Cumulative depth', () => {
  it('sums from the inside market outward, including levels outside the range', () => {
    const c = cumulativeDepth(
      new Map([
        [99, 5],
        [98, 7],
        [96, 1],
      ]),
      new Map([
        [100, 4],
        [101, 6],
        [103, 2],
      ]),
      97,
      101,
    );
    // index = px - 97
    expect(Array.from(c.bid)).toEqual([12, 12, 5, 0, 0]);
    expect(Array.from(c.ask)).toEqual([0, 0, 0, 4, 10]);
    const c2 = cumulativeDepth(new Map([[99, 5]]), new Map([[100, 4]]), 98, 98);
    expect(c2.bid[0]).toBe(5);
    expect(c2.ask[0]).toBe(0);
  });
});

describe('Value area / POC', () => {
  it('finds the POC and expands to 70 %', () => {
    const v = new Map([
      [100, 10],
      [101, 20],
      [102, 40],
      [103, 15],
      [104, 5],
      [105, 10],
    ]);
    const va = computeValueArea(v, 0.7);
    expect(va.poc).toBe(102);
    expect(va.total).toBe(100);
    // 40 → +20 (101) = 60 → +15 (103) = 75 ≥ 70.
    expect(va.val).toBe(101);
    expect(va.vah).toBe(103);
  });

  it('handles empty input, gaps and ties', () => {
    expect(Number.isNaN(computeValueArea(new Map()).poc)).toBe(true);
    const gap = computeValueArea(
      new Map([
        [100, 10],
        [104, 10],
        [102, 10],
      ]),
      1,
    );
    expect(gap.poc).toBe(102);
    expect([gap.val, gap.vah]).toEqual([100, 104]);
  });

  it('model caches the value area until volume changes', () => {
    const m = new DomModel();
    const trades = [tr(T0, 100, 5, 'buy'), tr(T0 + 1, 101, 1, 'sell')];
    const bk = book([[99, 1]], [[100, 1]]);
    m.update(trades, bk, T0 + 2);
    const a = m.valueArea();
    expect(a.poc).toBe(100);
    expect(m.valueArea()).toBe(a);
    trades.push(tr(T0 + 3, 101, 10, 'buy'));
    m.update(trades, bk, T0 + 4);
    expect(m.valueArea().poc).toBe(101);
  });
});
