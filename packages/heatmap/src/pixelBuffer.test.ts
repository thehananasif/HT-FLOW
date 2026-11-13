import { describe, expect, it } from 'vitest';
import type { DepthColumn } from '@htflow/market-data';
import { lutFromStops, presetStops } from './gradient';
import { globalCutoffs } from './normalize';
import { AGE_BINS, HeatBuffer, lifetimeLut, lut32Of, type HeatFrame } from './pixelBuffer';
import { buildSurface } from './surface';
import { SyntheticBook, syntheticHistory } from './synthetic';

const lut = lutFromStops(presetStops('mono'));
const col = (t: number, levels: [number, number][]): DepthColumn => ({
  t,
  bestBid: 100,
  bestAsk: 101,
  pxs: Int32Array.from(levels.map((l) => l[0])),
  qtys: Float32Array.from(levels.map((l) => l[1])),
});

function frame(cols: DepthColumn[], over: Partial<HeatFrame> = {}): HeatFrame {
  return {
    colAt: (i) => cols[i],
    i0: 0,
    i1: cols.length - 1,
    top: 104,
    rowTicks: 1,
    lut32: lut32Of(lut),
    mode: 'global',
    global: { lo: 0, hi: 100 },
    lowerPct: 0,
    upperPct: 100,
    scale: 'linear',
    minSize: 0,
    largeSize: 0,
    lifetime: null,
    lookback: 0,
    ...over,
  };
}

const byte = (b: HeatBuffer, x: number, y: number) =>
  new Uint8Array(b.pixels.buffer)[(y * b.width + x) * 4]!;

describe('heat pixel buffer', () => {
  it('writes one pixel per column × price row from the top price down', () => {
    const b = new HeatBuffer();
    b.resize(2, 5);
    b.render(frame([col(0, [[104, 100]]), col(1, [[100, 50]])]));
    expect(byte(b, 0, 0)).toBe(255);
    expect(byte(b, 1, 4)).toBeGreaterThan(120);
    expect(byte(b, 1, 4)).toBeLessThan(136);
    expect(byte(b, 1, 0)).toBe(10); // background (mono stop 0 = #0A0A0A)
    expect(b.cells).toBe(2);
  });
  it('keeps the hottest value when rows merge and honours the min size', () => {
    const b = new HeatBuffer();
    b.resize(1, 3);
    b.render(
      frame(
        [
          col(0, [
            [104, 10],
            [103, 90],
            [100, 5],
          ]),
        ],
        { rowTicks: 2, minSize: 6 },
      ),
    );
    expect(byte(b, 0, 0)).toBeGreaterThan(200);
    expect(byte(b, 0, 2)).toBe(10);
  });
  it('per-column normalisation makes a thin column as bright as a busy one', () => {
    const cols = [
      col(0, [
        [104, 4],
        [103, 1],
      ]),
      col(1, [
        [104, 400],
        [103, 100],
      ]),
    ];
    const g = new HeatBuffer();
    g.resize(2, 5);
    g.render(frame(cols, { global: globalCutoffs(cols, 0, 1, 0, 100, null) }));
    expect(byte(g, 0, 0)).toBeLessThan(20);
    const c = new HeatBuffer();
    c.resize(2, 5);
    c.render(frame(cols, { mode: 'column' }));
    expect(byte(c, 0, 0)).toBe(255);
    expect(byte(c, 1, 0)).toBe(255);
  });
  it('collects runs of large orders for outlines', () => {
    const cols = [0, 1, 2, 3].map((t) => col(t, [[102, t === 2 ? 5 : 500]]));
    const b = new HeatBuffer();
    b.resize(4, 5);
    const runs = b.render(frame(cols, { largeSize: 100, global: { lo: 0, hi: 500 } }));
    expect(runs).toEqual([
      { px: 102, slot0: 0, slot1: 1, maxQty: 500 },
      { px: 102, slot0: 3, slot1: 3, maxQty: 500 },
    ]);
  });
  it('colours by order lifetime when enabled', () => {
    const cols = Array.from({ length: 20 }, (_, i) =>
      col(i * 1000, [[104, 100], ...(i === 19 ? ([[103, 100]] as [number, number][]) : [])]),
    );
    const life = lifetimeLut(
      lutFromStops([
        { pos: 0, color: '#000000' },
        { pos: 1, color: '#FFFFFF' },
      ]),
      '#0000FF',
      '#FF0000',
    );
    expect(life.length).toBe(AGE_BINS * 256);
    const b = new HeatBuffer();
    b.resize(1, 5);
    b.render(
      frame(cols, { i0: 19, i1: 19, lifetime: { lut: life, maxAgeMs: 10_000 }, lookback: 19 }),
    );
    const px = new Uint8Array(b.pixels.buffer);
    // Row 0 has rested 19 s → old colour (red); row 1 just appeared → young colour (blue).
    expect(px[0]).toBe(255);
    expect(px[2]).toBe(0);
    expect(px[4]).toBe(0);
    expect(px[6]).toBe(255);
  });
});

describe('3D surface', () => {
  it('max-pools depth into a bounded grid', () => {
    const h = syntheticHistory(400);
    const mid = h.depth[200]!.bestBid;
    const s = buildSurface((i) => h.depth[i], 0, 399, mid - 50, mid + 50, {
      maxCols: 100,
      maxRows: 40,
      mode: 'column',
      global: { lo: 0, hi: 1 },
      lowerPct: 20,
      upperPct: 98,
      scale: 'sqrt',
      minSize: 0,
    });
    expect(s.cols).toBe(100);
    expect(s.rows).toBe(40);
    expect(s.idx.some((v) => v === 255)).toBe(true);
    expect(s.t1).toBeGreaterThan(s.t0);
  });
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('heat buffer performance smoke (CL-like replay)', () => {
  // Functional checks plus a catastrophic-regression ceiling only. Single timings are noisy when
  // every suite shares the CPU, so each figure is the median of several frames and the ceiling is
  // far above the 33 ms budget; the strict 30 fps numbers (2,000 × 400) come from `pnpm bench`.
  it('fills a 600 × 300 frame of 250 ms columns, deterministically, without blowing up', () => {
    const h = syntheticHistory(700, { seed: 11 });
    const b = new HeatBuffer();
    const cols = 600;
    const rows = 300;
    b.resize(cols, rows);
    const lut32 = lut32Of(lutFromStops(presetStops('thermal')));
    const mid = h.depth[h.depth.length - 1]!.bestBid;
    const base = h.depth.length - cols;
    const f: HeatFrame = {
      ...frame([], {}),
      colAt: (i) => h.depth[base + i],
      i0: 0,
      i1: cols - 1,
      top: mid + 150,
      lut32,
      global: globalCutoffs(h.depth, base, base + cols - 1, 20, 98, null),
      lowerPct: 20,
      upperPct: 98,
      scale: 'sqrt',
    };
    b.render(f);
    const first = b.pixels.slice();
    expect(b.cells).toBeGreaterThan(cols * 50);
    const full: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      b.render(f);
      full.push(performance.now() - t0);
    }
    // Same input → same pixels.
    expect(b.pixels).toEqual(first);
    const perCol = new SyntheticBook({ seed: 5 });
    // Live append: one new column per frame, cut-offs per column.
    const live = h.depth.slice(base);
    const liveT: number[] = [];
    for (let k = 0; k < 7; k++) {
      live.shift();
      live.push(perCol.step().col);
      const t0 = performance.now();
      b.render({ ...f, colAt: (i) => live[i], mode: 'column' });
      liveT.push(performance.now() - t0);
    }
    expect(b.cells).toBeGreaterThan(cols * 50);
    expect(median(full)).toBeLessThan(250);
    expect(median(liveT)).toBeLessThan(250);
  }, 30_000);
});
