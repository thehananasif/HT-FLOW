// @vitest-environment jsdom
/**
 * Heatmap target (HARD CONSTRAINTS 4, P11): 30 fps with 400 price levels × 2,000 columns.
 * Measured on the app's liquidity-map chart template (LiquidityMapLayer on ChartCore) with a live
 * column appended every frame, plus the pixel buffer alone.
 */
import { describe, expect, it } from 'vitest';
import { MarketStore, findMockInstrument } from '@htflow/market-data';
import {
  HeatBuffer,
  type SyntheticBook,
  globalCutoffs,
  lut32Of,
  lutFromStops,
  presetStops,
  syntheticHistory,
  type HeatFrame,
  type LiquidityMapLayer,
} from '@htflow/heatmap';
import { THEMES } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';
import { installHeadlessDom, measure, record, renderFrame, sizedHost } from './harness';

installHeadlessDom();

const { buildChart } = await import('../ui/src/charts/buildChart');
const { toPalette } = await import('../ui/src/charts/palette');

const FRAME_30 = 1000 / 30;
const COLS = 2000;
const LEVELS = 400;

describe('heatmap (headless frame cost)', () => {
  it(`pixel buffer ${COLS} columns × ${LEVELS} levels`, () => {
    const h = syntheticHistory(COLS + 200, { seed: 11, levels: LEVELS / 2 });
    const base = h.depth.length - COLS;
    const mid = h.depth[h.depth.length - 1]!.bestBid;
    const buf = new HeatBuffer();
    buf.resize(COLS, LEVELS);
    const frame: HeatFrame = {
      colAt: (i) => h.depth[base + i],
      i0: 0,
      i1: COLS - 1,
      top: mid + LEVELS / 2,
      rowTicks: 1,
      lut32: lut32Of(lutFromStops(presetStops('thermal'))),
      mode: 'global',
      global: globalCutoffs(h.depth, base, base + COLS - 1, 20, 98, null),
      lowerPct: 20,
      upperPct: 98,
      scale: 'sqrt',
      minSize: 0,
      largeSize: 0,
      lifetime: null,
      lookback: 0,
    };
    const m = measure(() => buf.render(frame), { warmup: 5, runs: 40 });
    record({
      group: 'Heatmap',
      name: `Pixel buffer only, ${COLS} × ${LEVELS} (${buf.cells.toLocaleString('en')} cells)`,
      target: '30 fps with 400 levels × 2,000 columns',
      budget: FRAME_30,
      unit: 'ms/frame',
      ...m,
    });
    expect(m.median).toBeLessThan(FRAME_30 * 6);
  });

  it('liquidity-map chart, live column appended every frame', () => {
    const inst = findMockInstrument('BTCUSDT')!.instrument;
    const store = new MarketStore(inst, { maxDepthColumns: 4000 });
    const hist = syntheticHistory(COLS + 300, { seed: 3, levels: LEVELS / 2 });
    const last = hist.depth[hist.depth.length - 1]!;
    store.loadHistory({
      trades: hist.trades,
      depth: hist.depth,
      book: { ts: last.t, bids: [[last.bestBid, 10]], asks: [[last.bestAsk, 10]] },
      end: last.t,
    });
    const state = {
      kind: 'chart',
      instrumentId: inst.id,
      template: 'liquidity-map',
      timeframe: { kind: 'time', ms: 60_000 },
      lots: 1,
      link: 'none',
      footprintMode: 'volume',
      heatColumnMs: 250,
      minLots: 5,
    } as ChartWindowState;
    // Plot width = 2,000 one-pixel columns + the DOM column + 30 empty right-margin slots.
    const handle = buildChart(
      [sizedHost(COLS + 150 + 30 + 4, 900)],
      store,
      state,
      toPalette(THEMES.dark),
    );
    const core = handle.main;
    const layer = core.layers.find((l) => l.id === 'liquidity-map') as LiquidityMapLayer;
    layer.settings.rangeLevels = Math.round(LEVELS / 2 - 10);
    core.slotWidth = 1;
    const feed: SyntheticBook = hist.book;
    const m = measure(
      () => {
        const s = feed.step();
        store.depth.push(s.col);
        store.depth.shift();
        for (const t of s.trades) store.trades.push(t);
        core.invalidate();
        renderFrame(core);
      },
      { warmup: 5, runs: 60 },
    );
    const st = layer.stats;
    record({
      group: 'Heatmap',
      name: `Liquidity map, ${st.cols} × ${st.rows} visible (bubbles, best bid / ask, DOM column on), live append`,
      target: '30 fps with 400 levels × 2,000 columns',
      budget: FRAME_30,
      unit: 'ms/frame',
      ...m,
    });
    expect(st.cols).toBeGreaterThanOrEqual(COLS);
    expect(st.rows).toBeGreaterThanOrEqual(LEVELS);
    expect(m.median).toBeLessThan(FRAME_30 * 6);
    handle.dispose();
  });
});
