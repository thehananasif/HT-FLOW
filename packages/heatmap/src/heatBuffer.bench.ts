/**
 * Pixel-buffer benchmark (P11 acceptance: CL-like replay at 30 fps).
 * Run: `pnpm exec vitest bench --run packages/heatmap`
 */
import { bench, describe } from 'vitest';
import { lutFromStops, presetStops } from './gradient';
import { globalCutoffs } from './normalize';
import { HeatBuffer, lifetimeLut, lut32Of, type HeatFrame } from './pixelBuffer';
import { LiquidityTracker } from './detectors';
import { SyntheticBook, syntheticHistory } from './synthetic';

const COLS = 1200;
const ROWS = 600;
const h = syntheticHistory(COLS + 400, { seed: 11 });
const base = h.depth.length - COLS;
const lut = lutFromStops(presetStops('thermal'));
const mid = h.depth[h.depth.length - 1]!.bestBid;
const frame: HeatFrame = {
  colAt: (i) => h.depth[base + i],
  i0: 0,
  i1: COLS - 1,
  top: mid + 300,
  rowTicks: 1,
  lut32: lut32Of(lut),
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
const buf = new HeatBuffer();
buf.resize(COLS, ROWS);
const live = h.depth.slice(base);
const feed = new SyntheticBook({ seed: 5 });

describe(`heat pixel buffer ${COLS}×${ROWS} (5 min of 250 ms CL columns)`, () => {
  bench('full frame, global cut-offs', () => {
    buf.render(frame);
  });
  bench('live append, per-column cut-offs', () => {
    live.shift();
    live.push(feed.step().col);
    buf.render({ ...frame, colAt: (i) => live[i], mode: 'column' });
  });
  bench('full frame + large-order runs + lifetime colours', () => {
    buf.render({
      ...frame,
      largeSize: 100,
      lifetime: { lut: lifetimeLut(lut, '#4FA3F7', '#F5D547'), maxAgeMs: 120_000 },
      lookback: 480,
      i0: 480,
    });
  });
  bench('global cut-offs (visible window sample)', () => {
    globalCutoffs(h.depth, base, base + COLS - 1, 20, 98, [mid - 300, mid + 300]);
  });
  bench('detectors: ingest one column', () => {
    tracker.ingest(feed.step().col);
  });
});

const tracker = new LiquidityTracker();
