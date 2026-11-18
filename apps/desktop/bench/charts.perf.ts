// @vitest-environment jsdom
/**
 * Chart targets (HARD CONSTRAINTS 4, P08, P10, P46):
 * - 60 fps chart pan / zoom with 1M+ ticks loaded
 * - open 8 charts at once at 60 fps
 * - 2,000 visible footprint clusters render at 60 fps
 * - switching footprint mode < 50 ms
 * Charts are built with the app's own `buildChart` (same templates and layers as the chart window).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MarketStore, findMockInstrument, type Trade } from '@htflow/market-data';
import { mergeRows, type FootprintLayer } from '@htflow/footprint';
import { THEMES } from '@htflow/ui-kit';
import type { ChartWindowState } from '@htflow/workspace';
import { installHeadlessDom, measure, record, renderFrame, rng, sizedHost } from './harness';

installHeadlessDom();

const { buildChart } = await import('../ui/src/charts/buildChart');
const { toPalette } = await import('../ui/src/charts/palette');

const FRAME_60 = 1000 / 60;
const TICKS = 1_000_000;
const inst = findMockInstrument('BTCUSDT')!.instrument;
const palette = toPalette(THEMES.dark);

/** 1M deterministic prints over 4 days (the P46 "4 days of history" case). */
function ticks(n: number): Trade[] {
  const r = rng(7);
  const out: Trade[] = new Array(n);
  const span = 4 * 86_400_000;
  const t0 = Date.UTC(2026, 10, 9);
  let px = 9_000_000;
  for (let i = 0; i < n; i++) {
    const u = r();
    if (u < 0.3) px -= 1 + Math.floor(r() * 3);
    else if (u > 0.7) px += 1 + Math.floor(r() * 3);
    out[i] = {
      ts: t0 + Math.floor((i * span) / n),
      px,
      qty: 1 + Math.floor(r() * r() * 20),
      side: r() < 0.5 ? 'buy' : 'sell',
      id: i + 1,
    };
  }
  return out;
}

let store: MarketStore;

function chartState(template: ChartWindowState['template'], ms: number): ChartWindowState {
  return {
    kind: 'chart',
    instrumentId: inst.id,
    template,
    timeframe: { kind: 'time', ms },
    lots: 1,
    link: 'none',
    footprintMode: 'bidask',
    heatColumnMs: 250,
    minLots: 5,
  } as ChartWindowState;
}

function chart(template: ChartWindowState['template'], ms: number, w: number, h: number) {
  const handle = buildChart(
    [sizedHost(w, h), sizedHost(w, h)],
    store,
    chartState(template, ms),
    palette,
  );
  return handle;
}

/** One pan / zoom step: alternate panning left / right and zooming in / out around a base width. */
function panZoom(
  core: { rightOffset: number; slotWidth: number; invalidate(): void },
  k: number,
  base: number,
) {
  const phase = k % 40;
  if (phase < 20) core.rightOffset += phase < 10 ? 3 : -3;
  else core.slotWidth = base * (phase < 30 ? 1 + (phase - 20) * 0.03 : 1.3 - (phase - 30) * 0.03);
  core.invalidate();
}

beforeAll(() => {
  store = new MarketStore(inst);
  const trades = ticks(TICKS);
  const last = trades[trades.length - 1]!;
  store.loadHistory({
    trades,
    depth: [],
    book: {
      ts: last.ts,
      bids: Array.from({ length: 50 }, (_, i) => [last.px - 1 - i, 5 + i] as [number, number]),
      asks: Array.from({ length: 50 }, (_, i) => [last.px + i, 5 + i] as [number, number]),
    },
    end: last.ts,
  });
}, 120_000);

describe('charts (headless frame cost)', () => {
  it('candles + session profiles, 1M ticks on M1, pan / zoom at 1600×900', () => {
    const h = chart('candles-vp', 60_000, 1600, 900);
    const core = h.main;
    core.slotWidth = 8;
    const m = measure(
      (k) => {
        panZoom(core, k, 8);
        renderFrame(core);
      },
      { warmup: 10, runs: 120 },
    );
    record({
      group: 'Charts',
      name: `Candles + profiles, ${TICKS.toLocaleString('en')} ticks (${h.series()!.bars.length} M1 bars), pan / zoom`,
      target: '60 fps pan / zoom with 1M+ ticks',
      budget: FRAME_60,
      unit: 'ms/frame',
      ...m,
    });
    expect(m.median).toBeLessThan(FRAME_60 * 6);
    h.dispose();
  }, 120_000);

  it('candles zoomed fully out (every bar visible)', () => {
    const h = chart('candles-vp', 60_000, 1600, 900);
    const core = h.main;
    core.slotWidth = 1;
    const m = measure(
      (k) => {
        core.rightOffset = 4 + (k % 7);
        core.invalidate();
        renderFrame(core);
      },
      { warmup: 5, runs: 60 },
    );
    record({
      group: 'Charts',
      name: `Candles zoomed out, ~${Math.min(h.series()!.bars.length, 1500)} bars visible`,
      target: '60 fps pan / zoom with 1M+ ticks',
      budget: FRAME_60,
      unit: 'ms/frame',
      ...m,
    });
    expect(m.median).toBeLessThan(FRAME_60 * 6);
    h.dispose();
  }, 120_000);

  it('footprint (bid x ask), 1M ticks on M5, pan / zoom', () => {
    const h = chart('footprint', 300_000, 1600, 900);
    const core = h.main;
    const m = measure(
      (k) => {
        panZoom(core, k, 118);
        renderFrame(core);
      },
      { warmup: 10, runs: 120 },
    );
    record({
      group: 'Charts',
      name: `Footprint bid x ask, ${TICKS.toLocaleString('en')} ticks (${h.series()!.bars.length} M5 bars), pan / zoom`,
      target: '60 fps pan / zoom with 1M+ ticks',
      budget: FRAME_60,
      unit: 'ms/frame',
      ...m,
    });
    expect(m.median).toBeLessThan(FRAME_60 * 6);
    h.dispose();
  }, 120_000);

  it('2,000+ visible footprint clusters', () => {
    // A trader's zoom on a 2560×1600 screen: M15 bars, one tick per row, ~10 px rows.
    const h = chart('footprint', 900_000, 2560, 1600);
    const core = h.main;
    const fp = h.layers.footprint as FootprintLayer;
    fp.settings.ticksPerRow = 1;
    core.slotWidth = 36;
    core.invalidate();
    renderFrame(core);
    let v = core.view!;
    const bars = h.series()!.bars;
    const mid = Math.round((bars[v.i1]!.h + bars[v.i1]!.l) / 2);
    core.autoScale = false;
    core.priceMin = mid - 78;
    core.priceMax = mid + 78;
    core.invalidate();
    renderFrame(core);
    v = core.view!;
    let cells = 0;
    for (let i = Math.max(0, v.i0); i <= v.i1; i++)
      for (const r of mergeRows(bars[i]!, fp.rowTicks))
        if (r.px >= v.priceMin && r.px <= v.priceMax) cells++;
    const m = measure(
      (k) => {
        core.rightOffset = 0.6 + (k % 2) * 0.01;
        core.invalidate();
        renderFrame(core);
      },
      { warmup: 10, runs: 120 },
    );
    record({
      group: 'Footprint',
      name: `${cells.toLocaleString('en')} visible cells (${v.i1 - v.i0 + 1} M15 bars, 1 tick per row) at 2560×1600`,
      target: '2,000 visible clusters at 60 fps',
      budget: FRAME_60,
      unit: 'ms/frame',
      ...m,
    });
    expect(cells).toBeGreaterThanOrEqual(2000);
    expect(m.median).toBeLessThan(FRAME_60 * 6);
    h.dispose();
  }, 120_000);

  it('large footprint: Canvas2D vs WebGL2 backend frame time', () => {
    // Same frame as above (one tick per row, ~2,000+ cells) drawn by each backend.
    const h = chart('footprint', 900_000, 2560, 1600);
    const core = h.main;
    const fp = h.layers.footprint as FootprintLayer;
    fp.settings.ticksPerRow = 1;
    core.slotWidth = 36;
    core.invalidate();
    renderFrame(core);
    const bars = h.series()!.bars;
    const v = core.view!;
    const mid = Math.round((bars[v.i1]!.h + bars[v.i1]!.l) / 2);
    core.autoScale = false;
    core.priceMin = mid - 78;
    core.priceMax = mid + 78;
    const results: Record<string, number> = {};
    for (const renderer of ['canvas2d', 'webgl2'] as const) {
      core.setOptions({ renderer });
      expect(core.backend).toBe(renderer);
      const m = measure(
        (k) => {
          core.rightOffset = 0.6 + (k % 2) * 0.01;
          core.invalidate();
          renderFrame(core);
        },
        { warmup: 10, runs: 120 },
      );
      results[renderer] = m.median;
      record({
        group: 'Footprint',
        name: `Large footprint (2,000+ cells, 2560×1600) — ${renderer === 'webgl2' ? 'WebGL2' : 'Canvas2D'} backend`,
        target: '2,000 visible clusters at 60 fps',
        budget: FRAME_60,
        unit: 'ms/frame',
        notes: 'CPU cost per frame (headless context): rects / draw-call stream, text included',
        ...m,
      });
    }
    expect(results.webgl2).toBeLessThan(FRAME_60 * 6);
    h.dispose();
  }, 120_000);

  it('switching footprint mode', () => {
    const h = chart('footprint', 300_000, 1600, 900);
    const core = h.main;
    renderFrame(core);
    const modes = ['volume', 'bidask', 'delta', 'trades', 'voldelta', 'deltaProfile'];
    const m = measure(
      (k) => {
        h.update({ ...chartState('footprint', 300_000), footprintMode: modes[k % modes.length]! });
        renderFrame(core);
      },
      { warmup: 6, runs: 60 },
    );
    record({
      group: 'Footprint',
      name: 'Switch footprint mode (update + first frame)',
      target: 'switching footprint mode < 50 ms',
      budget: 50,
      unit: 'ms',
      ...m,
    });
    expect(m.median).toBeLessThan(250);
    h.dispose();
  }, 120_000);

  it('8 charts open at once (4 footprint + 4 candles), 800×450 each, all redraw every frame', () => {
    const handles = Array.from({ length: 8 }, (_, i) =>
      i % 2 ? chart('candles-vp', 60_000, 800, 450) : chart('footprint', 300_000, 800, 450),
    );
    const bases = handles.map((h) => h.main.slotWidth);
    const m = measure(
      (k) => {
        handles.forEach((h, i) => {
          panZoom(h.main, k, bases[i]!);
          renderFrame(h.main);
        });
      },
      { warmup: 5, runs: 60 },
    );
    record({
      group: 'Charts',
      name: '8 charts, every chart redrawn in the same frame',
      target: 'open 8 charts at once at 60 fps',
      budget: FRAME_60,
      unit: 'ms/frame',
      ...m,
    });
    expect(m.median).toBeLessThan(FRAME_60 * 8);
    for (const h of handles) h.dispose();
  }, 120_000);
});
