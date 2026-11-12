import { describe, expect, it } from 'vitest';
import { BarSeries, type BarSpec } from '@htflow/market-data';
import { simulatedDataset } from './dataset';
import { ReplayEngine } from './engine';
import { ghostBars, ghostRange, ghostSlot } from './ghost';

const T0 = Date.UTC(2026, 10, 3, 0, 10, 0);
const MIN = 60_000;
const M1: BarSpec = { kind: 'time', ms: MIN };

describe('ghost (future) bars', () => {
  const ds = simulatedDataset('CLZ6', T0, T0 + 30 * MIN);

  it('are the bars after the running bar and match the bars the replay later builds', () => {
    const e = new ReplayEngine(ds);
    e.advanceTo(T0 + 10 * MIN + 20_000);
    const real = BarSeries.build(M1, ds.trades.slice(0, e.tradeIndex));
    const last = real.bars[real.bars.length - 1]!;
    const ghost = ghostBars(ds.trades, e.tradeIndex, M1, last.t, { maxBars: 5 });
    expect(ghost).toHaveLength(5);
    expect(ghost[0]!.t).toBe(last.t + MIN);
    expect(ghost.every((b, i) => i === 0 || b.t > ghost[i - 1]!.t)).toBe(true);
    // Play on: the real bars become exactly what the ghosts promised (never leaked early).
    e.advanceTo(T0 + 16 * MIN + 1);
    const later = BarSeries.build(M1, ds.trades.slice(0, e.tradeIndex));
    const g0 = later.bars.find((b) => b.t === ghost[0]!.t)!;
    expect([g0.o, g0.h, g0.l, g0.c, g0.vol]).toEqual([
      ghost[0]!.o,
      ghost[0]!.h,
      ghost[0]!.l,
      ghost[0]!.c,
      ghost[0]!.vol,
    ]);
  });

  it('are empty at the end of the data and honour maxBars; count-based bars skip the running bar', () => {
    expect(ghostBars(ds.trades, ds.trades.length, M1, T0, {})).toEqual([]);
    expect(ghostBars(ds.trades, 0, M1, null, { maxBars: 3 })).toHaveLength(3);
    expect(ghostBars(ds.trades, 0, M1, T0, { maxBars: 0 })).toEqual([]);
    const tick: BarSpec = { kind: 'tick', n: 500 };
    const g = ghostBars(ds.trades, 1000, tick, null, { maxBars: 4 });
    const all = BarSeries.build(tick, ds.trades.slice(1000)).bars;
    expect(g).toHaveLength(4);
    expect(g[0]!.t).toBe(all[1]!.t);
  });

  it('slot placement and autoscale range', () => {
    expect(ghostSlot(41, 0)).toBe(42);
    expect(ghostSlot(41, 3)).toBe(45);
    const g = ghostBars(ds.trades, 0, M1, null, { maxBars: 4 });
    const all = ghostRange(g, 10, 0, 100)!;
    expect(all[0]).toBe(Math.min(...g.map((b) => b.l)));
    expect(all[1]).toBe(Math.max(...g.map((b) => b.h)));
    expect(ghostRange(g, 10, 0, 5)).toBeNull();
    expect(ghostRange(g, 10, 11, 11)).toEqual([g[0]!.l, g[0]!.h]);
  });
});
