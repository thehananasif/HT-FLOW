import { describe, expect, it } from 'vitest';
import { BarSeries, type Trade } from '@htflow/market-data';
import { MemorySource, simulatedDataset, SimulatedSource, type ReplayDataset } from './dataset';
import { ReplayEngine } from './engine';
import {
  DEFAULT_LOOKBACK,
  loadLookback,
  lookbackMs,
  lookbackSlices,
  lookbackTrades,
  MAX_LOOKBACK_MS,
  normalizeLookback,
  withLookback,
} from './lookback';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 19, 0, 13, 0);

const tr = (ts: number, px = 100): Trade => ({ ts, px, qty: 1, side: 'buy' }) as Trade;

function mainDs(start: number, trades: Trade[]): ReplayDataset {
  return simulatedLike(start, start + HOUR, trades);
}
function simulatedLike(start: number, end: number, trades: Trade[]): ReplayDataset {
  const d = simulatedDataset('CLZ6', start, start + MIN, { ticks: true, depth: false });
  return { ...d, start, end, trades };
}

describe('look-back settings', () => {
  it('defaults to one day and clamps garbage', () => {
    expect(normalizeLookback(undefined)).toEqual(DEFAULT_LOOKBACK);
    expect(normalizeLookback({ unit: 'bars' })).toEqual({ amount: 300, unit: 'bars' });
    expect(normalizeLookback({ unit: 'bars', amount: 99_999 })).toEqual({
      amount: 5000,
      unit: 'bars',
    });
    expect(normalizeLookback({ unit: 'days', amount: -3 })).toEqual({ amount: 0, unit: 'days' });
    expect(normalizeLookback({ unit: 'weeks', amount: 2 }).unit).toBe('days');
  });

  it('turns bars into time with the chart bar length and caps the total', () => {
    expect(lookbackMs({ amount: 300, unit: 'bars' }, 5 * MIN)).toBe(25 * HOUR);
    expect(lookbackMs({ amount: 300, unit: 'bars' })).toBe(25 * HOUR); // M5 default
    expect(lookbackMs({ amount: 1, unit: 'days' })).toBe(DAY);
    expect(lookbackMs({ amount: 0, unit: 'days' })).toBe(0);
    expect(lookbackMs({ amount: 5000, unit: 'bars' }, HOUR)).toBe(MAX_LOOKBACK_MS);
  });

  it('splits the look-back at UTC midnights', () => {
    expect(lookbackSlices(T0 - DAY, T0)).toEqual([
      [T0 - DAY, Date.UTC(2026, 10, 19)],
      [Date.UTC(2026, 10, 19), T0],
    ]);
    expect(lookbackSlices(T0, T0)).toEqual([]);
  });
});

describe('pre-history slice', () => {
  it('keeps only trades before the replay start, in order, without duplicates', () => {
    const main = mainDs(T0, [tr(T0), tr(T0 + 1000)]);
    const pre = [tr(T0 - 3000), tr(T0 - 2000), tr(T0 - 2500), tr(T0), tr(T0 + 500)];
    expect(lookbackTrades(main, pre).map((t) => t.ts)).toEqual([T0 - 3000, T0 - 2000]);
    // A trade stamped exactly at start belongs to the look-back when the replay has none there.
    const main2 = mainDs(T0, [tr(T0 + 1000)]);
    expect(lookbackTrades(main2, pre).map((t) => t.ts)).toEqual([T0 - 3000, T0 - 2000, T0]);
  });

  it('prepends the look-back without moving the replay start', () => {
    const main = mainDs(T0, [tr(T0 + 1000), tr(T0 + 2000)]);
    const d = withLookback(main, [tr(T0 - 5000), tr(T0 - 4000)]);
    expect(d.start).toBe(T0);
    expect(d.historyStart).toBe(T0 - 5000);
    expect(d.trades.map((t) => t.ts)).toEqual([T0 - 5000, T0 - 4000, T0 + 1000, T0 + 2000]);
    expect(withLookback(main, [])).toBe(main);
  });

  it('engine: history is visible at the start, never replayed, and step back stops there', () => {
    const main = simulatedDataset('CLZ6', T0, T0 + 10 * MIN, { ticks: true, depth: true });
    const pre = simulatedDataset('CLZ6', T0 - 2 * HOUR, T0, { ticks: true, depth: false }).trades;
    const e = new ReplayEngine(withLookback(main, pre));
    expect(e.start).toBe(main.start);
    expect(e.time).toBe(main.start);
    expect(e.historyTrades).toBeGreaterThan(1000);
    expect(e.progressTrades.done).toBe(0);
    expect(e.progressTrades.total).toBe(e.dataset.trades.length - e.historyTrades);
    // At start the chart already holds ~2 h of M5 bars, none after the clock.
    const st = e.state();
    expect(st.trades.length).toBe(e.historyTrades);
    expect(st.trades.every((t) => t.ts <= e.time)).toBe(true);
    const bars = BarSeries.build({ kind: 'time', ms: 5 * MIN }, st.trades).bars;
    expect(bars.length).toBeGreaterThanOrEqual(23);
    // Step back at the start cannot remove history.
    e.stepBackBar({ kind: 'time', ms: 5 * MIN });
    expect(e.tradeIndex).toBe(e.historyTrades);
    e.stepBar({ kind: 'time', ms: 5 * MIN });
    expect(e.progressTrades.done).toBeGreaterThan(0);
    e.stepBackBar({ kind: 'time', ms: 5 * MIN });
    e.stepBackBar({ kind: 'time', ms: 5 * MIN });
    expect(e.tradeIndex).toBe(e.historyTrades);
    expect(e.time).toBe(e.start);
  });

  it('simulator: the look-back joins the replay seamlessly (same day seed)', async () => {
    const src = new SimulatedSource(() => T0 + DAY);
    const main = await src.load('CLZ6', T0, T0 + 5 * MIN, { ticks: true, depth: false });
    const pre = await loadLookback(src, 'CLZ6', main.start, 13 * MIN);
    // Same trades as one continuous simulation of the day.
    const whole = simulatedDataset('CLZ6', T0 - 13 * MIN, T0 + 5 * MIN, {
      ticks: true,
      depth: false,
    });
    const joined = withLookback(main, pre).trades;
    expect(joined.map((t) => [t.ts, t.px, t.qty])).toEqual(
      whole.trades.map((t) => [t.ts, t.px, t.qty]),
    );
  });

  it('memory source: clipped to the recorded range, gaps skipped', async () => {
    const trades = [tr(T0 - 2 * HOUR), tr(T0 - HOUR), tr(T0 - 1), tr(T0), tr(T0 + 1000)];
    const inst = simulatedDataset('CLZ6', T0, T0 + MIN).instrument;
    const src = new MemorySource(() => ({ instrument: inst, trades, depth: [] }));
    const pre = await loadLookback(src, 'x', T0, DAY);
    expect(pre.map((t) => t.ts)).toEqual([T0 - 2 * HOUR, T0 - HOUR, T0 - 1, T0]);
    const main = await src.load('x', T0, T0 + HOUR);
    expect(withLookback(main, pre).trades.map((t) => t.ts)).toEqual(trades.map((t) => t.ts));
    expect(await loadLookback(src, 'x', T0, 0)).toEqual([]);
  });
});
