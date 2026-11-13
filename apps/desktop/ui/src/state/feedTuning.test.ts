import { describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@htflow/market-data';
import { Conflator, mergeBatches, reconnectDelayMs, restamp } from './feedTuning';

const tr = (ts: number, id: number) => ({ ts, px: 100, qty: 1, side: 'buy' as const, id });
const b = (ts: number, extra: Partial<EventBatch> = {}): EventBatch => ({
  ts,
  trades: [tr(ts, ts)],
  deltas: [{ side: 'buy', px: ts, qty: 1 }],
  ...extra,
});

describe('Settings → Data on live feeds', () => {
  it('merges batches; a snapshot drops earlier deltas', () => {
    const m = mergeBatches([b(1), b(2, { snapshot: { ts: 2, bids: [], asks: [] } }), b(3)])!;
    expect(m.ts).toBe(3);
    expect(m.trades.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(m.deltas.map((d) => d.px)).toEqual([2, 3]);
    expect(m.snapshot?.ts).toBe(2);
    expect(mergeBatches([])).toBeNull();
  });

  it('local timestamps replace exchange time', () => {
    const r = restamp(b(5), 99);
    expect(r.ts).toBe(99);
    expect(r.trades[0]!.ts).toBe(99);
  });

  it('back-off doubles and is capped', () => {
    expect([0, 1, 2, 3].map((a) => reconnectDelayMs(a, 30))).toEqual([500, 1000, 2000, 4000]);
    expect(reconnectDelayMs(10, 30)).toBe(30_000);
    expect(reconnectDelayMs(10, 5)).toBe(5000);
  });

  it('conflation window collects then emits once; 0 passes through', () => {
    vi.useFakeTimers();
    const out: EventBatch[] = [];
    let w = 100;
    const c = new Conflator(
      (x) => out.push(x),
      () => w,
    );
    c.push(b(1));
    c.push(b(2));
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(out).toHaveLength(1);
    expect(out[0]!.trades).toHaveLength(2);
    w = 0;
    c.push(b(3));
    expect(out).toHaveLength(2);
    vi.useRealTimers();
  });
});
