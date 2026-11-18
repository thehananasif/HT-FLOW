import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  FIRST_STEP_PAGES,
  MAX_BACKFILL_SPAN_MS,
  MAX_BACKFILL_STEPS,
  backfillSpanMs,
  progressLabel,
  runBackfill,
  type BackfillDeps,
} from './history';

describe('native backfill (P06)', () => {
  const H = 3_600_000;
  it('sizes background steps by the chart period', () => {
    // First step: a screen of 120 bars (at least an hour); later steps 3,000 bars.
    expect(backfillSpanMs(60_000, 0)).toBe(2 * H);
    expect(backfillSpanMs(60_000, 1)).toBe(50 * H);
    expect(backfillSpanMs(4 * H, 0)).toBe(20 * DAY_MS);
    expect(backfillSpanMs(DAY_MS, 3)).toBe(MAX_BACKFILL_SPAN_MS);
    expect(backfillSpanMs(1_000, 0)).toBe(H);
    // Tick / volume charts: 1 h, then 6 h.
    expect(backfillSpanMs(null, 0)).toBe(H);
    expect(backfillSpanMs(undefined, 5)).toBe(6 * H);
  });

  const deps = (over: Partial<BackfillDeps> & { venueBars?: number } = {}) => {
    let bars = 10;
    let first = 1_000 * DAY_MS;
    const venueStart = 1_000 * DAY_MS - (over.venueBars ?? 9_000) * 60_000;
    const calls: { span: number; maxPages?: number }[] = [];
    const d: BackfillDeps = {
      periodMs: 60_000,
      bars: () => bars,
      maxBars: 100_000,
      loadOlder: (span, opts) => {
        calls.push({ span, maxPages: opts?.maxPages });
        const from = Math.max(venueStart, first - span);
        const added = Math.round((first - from) / 60_000);
        first = from;
        bars += added;
        return Promise.resolve(added);
      },
      busy: () => false,
      exhausted: () => false,
      stopped: () => false,
      pause: () => Promise.resolve(),
      ...over,
    };
    return { d, calls, bars: () => bars };
  };

  it('loads back to the start of the venue history, the first step fast', async () => {
    const { d, calls, bars } = deps();
    const r = await runBackfill(d);
    expect(r.end).toBe('exhausted');
    expect(bars()).toBe(9_010);
    expect(calls[0]).toEqual({ span: 2 * H, maxPages: FIRST_STEP_PAGES });
    expect(calls[1]!.maxPages).toBeUndefined();
    // 120 + 3 × 3,000 bars, then an empty answer.
    expect(r.steps).toBe(5);
  });

  it('stops at the max-candles cap, when stopped, and never loops forever', async () => {
    const capped = deps({ venueBars: 1e9 });
    capped.d.maxBars = 7_000;
    expect((await runBackfill(capped.d)).end).toBe('max-candles');
    expect(capped.bars()).toBeLessThan(7_000 + 3_000 + 1);

    let n = 0;
    const stop = deps({ stopped: () => ++n > 3 });
    expect((await runBackfill(stop.d)).end).toBe('stopped');

    // A feed that always "adds" without bars growing (coarse bars): bounded by the step cap.
    const spin = deps({ loadOlder: () => Promise.resolve(1), bars: () => 1 });
    const r = await runBackfill(spin.d);
    expect(r).toEqual({ steps: MAX_BACKFILL_STEPS, end: 'step-cap' });

    // Busy (left-scroll in flight) waits instead of stopping, bounded too.
    const busy = deps({ busy: () => true });
    expect((await runBackfill(busy.d)).end).toBe('step-cap');
    expect(busy.calls).toHaveLength(0);
  });

  it('labels download progress', () => {
    expect(
      progressLabel({ doneMs: 45, totalMs: 100, trades: 120000, phase: 'trades', throttled: true }),
    ).toBe('Downloading ticks 45 % · 120,000 ticks · rate limited, slowing down');
    expect(
      progressLabel({ doneMs: 200, totalMs: 100, trades: 8, phase: 'klines', throttled: false }),
    ).toBe('Loading bar history 100 % · 8 ticks');
    expect(
      progressLabel({ doneMs: 0, totalMs: 0, trades: 0, phase: 'done', throttled: false }),
    ).toBe('History loaded 0 % · 0 ticks');
  });
});
