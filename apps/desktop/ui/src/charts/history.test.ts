import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  LAZY_SPAN_CAP_MS,
  LazyHistoryGate,
  autoLoadsHistory,
  lazySpanMs,
  loadChunks,
  spanLabel,
} from './history';

describe('chart history', () => {
  it('splits Go to date ranges into day chunks', () => {
    expect(loadChunks(2.5 * DAY_MS)).toEqual([DAY_MS, DAY_MS, DAY_MS / 2]);
    expect(loadChunks(0)).toEqual([]);
    expect(loadChunks(100 * DAY_MS, DAY_MS, 3)).toHaveLength(3);
  });

  it('auto-loads only from feeds with real older history', () => {
    expect(autoLoadsHistory('live', true)).toBe(true);
    expect(autoLoadsHistory('replay', true)).toBe(true);
    expect(autoLoadsHistory('mock', true)).toBe(false);
    expect(autoLoadsHistory('live', false)).toBe(false);
  });

  it('labels spans', () => {
    expect(spanLabel(6 * 3_600_000)).toBe('6 h');
    expect(spanLabel(1.5 * DAY_MS)).toBe('1.5 d');
    expect(spanLabel(30 * 60_000)).toBe('30 min');
  });
});

describe('lazy left-scroll history (coarse timeframes)', () => {
  const H = 3_600_000;

  it('caps each request per feed kind instead of 240 bars of the period', () => {
    // 1 min: 240 min = 4 h wanted, simulated feeds get 2 h steps.
    expect(lazySpanMs(60_000, 'mock')).toBe(LAZY_SPAN_CAP_MS.mock);
    expect(lazySpanMs(60_000, 'live')).toBe(4 * H);
    // 4 h used to ask for 40 days (~28M simulated ticks) at once.
    expect(lazySpanMs(4 * H, 'mock')).toBe(2 * H);
    expect(lazySpanMs(4 * H, 'live')).toBe(DAY_MS);
    expect(lazySpanMs(7 * DAY_MS, 'replay')).toBe(DAY_MS);
    expect(lazySpanMs(DAY_MS, null)).toBe(DAY_MS);
    // Non-time bars (null period) and seconds: at least one hour.
    expect(lazySpanMs(null, 'live')).toBe(4 * H);
    expect(lazySpanMs(1000, 'live')).toBe(H);
    expect(lazySpanMs(0, 'mock')).toBe(2 * H);
  });

  it('only loads after the user scrolls, never in a redraw loop', () => {
    const gate = new LazyHistoryGate(10);
    // Few bars: every redraw reports "past the start" at the same offset → no request.
    for (let i = 0; i < 100; i++) expect(gate.take(10)).toBe(false);
    // The user drags left: one request for that position…
    expect(gate.take(-40)).toBe(true);
    // …and none again from the redraws that follow the loaded chunk.
    expect(gate.take(-40)).toBe(false);
    expect(gate.take(-40.2)).toBe(false);
    // Further scrolling asks again.
    expect(gate.take(-80)).toBe(true);
    expect(gate.take(Number.NaN)).toBe(false);
  });

  it('is cancelled when the chart is rebuilt (timeframe change)', () => {
    const gate = new LazyHistoryGate(0);
    expect(gate.isDisposed).toBe(false);
    gate.dispose();
    expect(gate.isDisposed).toBe(true);
    expect(gate.take(-50)).toBe(false);
  });

  it('simulates the old loop: bounded requests over many redraws', () => {
    // Reproduces the 4 h freeze: each redraw reports past-start; count how many loads start.
    const gate = new LazyHistoryGate(5);
    let loads = 0;
    let offset = 5;
    for (let frame = 0; frame < 1000; frame++) {
      if (frame === 500) offset = -20; // one user drag
      if (gate.take(offset)) loads++;
    }
    expect(loads).toBe(1);
  });
});
