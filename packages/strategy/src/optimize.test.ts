import { describe, expect, it } from 'vitest';
import { simulatedDataset } from '@htflow/replay';
import type { BacktestConfig } from './backtest';
import { DeltaDivergence, StackedImbalance } from './examples';
import {
  Optimizer,
  WalkForward,
  buildGrid,
  gridValues,
  heatmapOf,
  rankRows,
  walkForwardWindows,
} from './optimize';
import { asAnyStrategy } from './types';
import { fromPlainData, toPlainData } from './serialize';
import { runBacktest } from './backtest';

const CFG: BacktestConfig = {
  instrument: {
    id: 'mock:ESZ6',
    symbol: 'ESZ6',
    tickSize: 0.25,
    tickValue: 12.5,
    pricePrecision: 2,
  },
  bars: { kind: 'time', ms: 60_000 },
  startingBalance: 50_000,
  commissionPerUnit: 2,
  takerFee: 0,
  slippageTicks: 1,
  fillModel: 'tape',
};
const now = Date.UTC(2026, 9, 7, 2);
const ds = simulatedDataset('mock:ESZ6', now - 90 * 60_000, now, { ticks: true, depth: false });

describe('optimiser grid', () => {
  it('builds inclusive ranges snapped to the step', () => {
    expect(gridValues({ from: 1, to: 2, step: 0.25 })).toEqual([1, 1.25, 1.5, 1.75, 2]);
    expect(gridValues({ from: 10, to: 5, step: 5 })).toEqual([5, 10]);
    expect(gridValues({ from: 0, to: 1000, step: 1 })).toHaveLength(50);
  });

  it('builds the cartesian grid, clamps to input limits and drops duplicates', () => {
    const def = asAnyStrategy(DeltaDivergence);
    const g = buildGrid(def.inputs, { qty: 2 }, [
      { key: 'lookback', from: 5, to: 15, step: 5 },
      { key: 'stop', from: 8, to: 12, step: 4 },
      { key: 'nope', from: 1, to: 3, step: 1 },
    ]);
    expect(g).toHaveLength(6);
    expect(g.every((c) => c.qty === 2)).toBe(true);
    expect(g.map((c) => `${c.lookback}/${c.stop}`)).toEqual([
      '5/8',
      '5/12',
      '10/8',
      '10/12',
      '15/8',
      '15/12',
    ]);
    // lookback min is 2: 0 and 1 clamp to 2 and collapse.
    expect(buildGrid(def.inputs, {}, [{ key: 'lookback', from: 0, to: 2, step: 1 }])).toHaveLength(
      1,
    );
  });

  it('runs every combination, chunked or not, with identical results', () => {
    const def = asAnyStrategy(StackedImbalance);
    const ranges = [
      { key: 'levels', from: 2, to: 3, step: 1 },
      { key: 'target', from: 10, to: 20, step: 10 },
    ];
    const a = new Optimizer(def, {}, ranges, ds, CFG, 'netPnl');
    a.step();
    const b = new Optimizer(def, {}, ranges, ds, CFG, 'netPnl');
    let n = 0;
    while (!b.step(0) && n++ < 1e6);
    expect(a.rows).toHaveLength(4);
    expect(b.rows).toEqual(a.rows);
    // Each row equals a standalone backtest with those inputs.
    const single = runBacktest(def, a.rows[1]!.inputs, ds, CFG);
    expect(a.rows[1]!.stats).toEqual(single.stats);
    const ranked = rankRows(a.rows);
    expect(a.best()).toBe(ranked[0]);
    for (let i = 1; i < ranked.length; i++)
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    const h = heatmapOf(a.rows, 'levels', 'target');
    expect(h.xs).toEqual([2, 3]);
    expect(h.ys).toEqual([10, 20]);
    expect(h.cells).toHaveLength(2);
    expect(h.cells[0]).toHaveLength(2);
  });

  it('splits walk-forward windows and trades only out of sample', () => {
    const w = walkForwardWindows(0, 1000, { folds: 4, inSample: 0.75 });
    expect(w).toHaveLength(4);
    expect(w[0]).toEqual({ isFrom: 0, isTo: 187.5, oosFrom: 187.5, oosTo: 250 });
    expect(w[3]!.oosTo).toBe(1000);
    const wf = new WalkForward(
      asAnyStrategy(DeltaDivergence),
      {},
      [{ key: 'lookback', from: 5, to: 10, step: 5 }],
      ds,
      CFG,
      'netPnl',
      { folds: 2, inSample: 0.7 },
    );
    wf.step();
    expect(wf.folds).toHaveLength(2);
    for (const f of wf.folds)
      for (const t of f.oos?.trades ?? []) {
        expect(t.entryTs).toBeGreaterThanOrEqual(f.oosFrom);
        expect(t.exitTs).toBeLessThanOrEqual(f.oosTo + 60_000);
      }
  });

  it('round-trips datasets through the worker format', () => {
    const p = fromPlainData(toPlainData(ds));
    expect(runBacktest(asAnyStrategy(DeltaDivergence), {}, p, CFG)).toEqual(
      runBacktest(asAnyStrategy(DeltaDivergence), {}, ds, CFG),
    );
  });
});
