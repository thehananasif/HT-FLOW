import { describe, expect, it } from 'vitest';
import type { DepthColumn, Trade } from '@htflow/market-data';
import { LiquidityTracker, TrackerSync } from './detectors';
import { syntheticHistory } from './synthetic';

/** Book with 10 lots on 95..100 (bids) and 101..106 (asks) plus extra levels. */
function column(t: number, extra: Record<number, number | undefined> = {}): DepthColumn {
  const lv = new Map<number, number>();
  for (let p = 95; p <= 106; p++) lv.set(p, 10);
  for (const [p, q] of Object.entries(extra)) {
    if (q === undefined || q <= 0) lv.delete(Number(p));
    else lv.set(Number(p), q);
  }
  return {
    t,
    bestBid: 100,
    bestAsk: 101,
    pxs: Int32Array.from(lv.keys()),
    qtys: Float32Array.from(lv.values()),
  };
}

let id = 1;
const trade = (ts: number, px: number, qty: number, side: 'buy' | 'sell'): Trade => ({
  ts,
  px,
  qty,
  side,
  id: id++,
});

/** Runs columns at 250 ms with an optional (t → extra levels / trades) script. */
function run(
  tracker: LiquidityTracker,
  n: number,
  extra: (t: number) => Record<number, number | undefined>,
  trades: (t: number) => Trade[] = () => [],
) {
  for (let k = 0; k < n; k++) {
    const t = 1000 + k * 250;
    tracker.ingest(column(t, extra(t)), trades(t));
  }
}

describe('spoof detector', () => {
  it('flags large liquidity away from the touch that is pulled before trading', () => {
    const tr = new LiquidityTracker();
    run(tr, 14, (t) => (t >= 1500 && t < 3000 ? { 97: 200 } : {}));
    expect(tr.spoofs).toHaveLength(1);
    expect(tr.spoofs[0]).toMatchObject({ px: 97, side: 'bid', size: 200, t0: 1500, t1: 3000 });
  });
  it('flags a partial pull (size drops to ≤ 20 %) as well', () => {
    const tr = new LiquidityTracker();
    run(tr, 14, (t) => (t >= 1500 && t < 3000 ? { 103: 300 } : t >= 3000 ? { 103: 20 } : {}));
    expect(tr.spoofs).toHaveLength(1);
    expect(tr.spoofs[0]).toMatchObject({ px: 103, side: 'ask', size: 300 });
  });
  it('does not flag liquidity that traded', () => {
    const tr = new LiquidityTracker();
    run(
      tr,
      14,
      (t) => (t >= 1500 && t < 3000 ? { 97: 200 } : {}),
      (t) => (t === 2500 ? [trade(2400, 97, 150, 'sell')] : []),
    );
    expect(tr.spoofs).toHaveLength(0);
  });
  it('does not flag small orders, touch orders or long-lived orders', () => {
    const small = new LiquidityTracker();
    run(small, 14, (t) => (t >= 1500 && t < 3000 ? { 97: 20 } : {}));
    expect(small.spoofs).toHaveLength(0);
    const touch = new LiquidityTracker();
    run(touch, 14, (t) => (t >= 1500 && t < 3000 ? { 100: 400 } : {}));
    expect(touch.spoofs).toHaveLength(0);
    const old = new LiquidityTracker({ spoofMaxLifeMs: 2000 });
    run(old, 30, (t) => (t >= 1500 && t < 6000 ? { 97: 300 } : {}));
    expect(old.spoofs).toHaveLength(0);
  });
  it('respects an absolute minimum size', () => {
    const tr = new LiquidityTracker({ spoofMinSize: 500 });
    run(tr, 14, (t) => (t >= 1500 && t < 3000 ? { 97: 200 } : {}));
    expect(tr.spoofs).toHaveLength(0);
  });
});

describe('iceberg detector', () => {
  it('flags a level that trades more than it shows while refilling', () => {
    const tr = new LiquidityTracker();
    // Ask 101 always shows 5; buyers lift 5 every column.
    run(
      tr,
      8,
      () => ({ 101: 5 }),
      (t) => (t > 1000 ? [trade(t - 100, 101, 5, 'buy')] : []),
    );
    expect(tr.icebergs).toHaveLength(1);
    const ib = tr.icebergs[0]!;
    expect(ib.px).toBe(101);
    expect(ib.side).toBe('ask');
    expect(ib.shown).toBe(5);
    expect(ib.traded).toBe(35);
    expect(ib.refills).toBeGreaterThanOrEqual(5);
  });
  it('ignores ordinary fills smaller than the displayed size', () => {
    const tr = new LiquidityTracker();
    run(
      tr,
      8,
      () => ({ 101: 50 }),
      (t) => (t === 1500 ? [trade(1400, 101, 3, 'buy')] : []),
    );
    expect(tr.icebergs).toHaveLength(0);
  });
});

describe('tracker sync', () => {
  it('incremental sync equals one full pass and survives front trimming', () => {
    const h = syntheticHistory(1200, { seed: 3 });
    const tradesBetween = (a: number, b: number) => h.trades.filter((t) => t.ts >= a && t.ts <= b);
    const full = new TrackerSync();
    full.sync(h.depth, tradesBetween, 1e9);
    const inc = new TrackerSync();
    const cols: DepthColumn[] = [];
    for (let i = 0; i < h.depth.length; i += 100) {
      cols.push(...h.depth.slice(i, i + 100));
      if (cols.length > 600) cols.splice(0, 100);
      while (inc.sync(cols, tradesBetween, 50));
    }
    expect(inc.tracker.spoofs.length).toBe(full.tracker.spoofs.length);
    expect(inc.tracker.icebergs.length).toBe(full.tracker.icebergs.length);
    expect(full.tracker.spoofs.length).toBeGreaterThan(0);
    expect(full.tracker.icebergs.length).toBeGreaterThan(0);
  });
  it('rebuilds when the history is replaced', () => {
    const a = syntheticHistory(300, { seed: 1 });
    const b = syntheticHistory(300, { seed: 2, startT: 0 });
    const s = new TrackerSync();
    s.sync(a.depth, () => [], 1e9);
    s.sync(b.depth, () => [], 1e9);
    expect(s.tracker.lastT).toBe(b.depth[b.depth.length - 1]!.t);
  });
});
