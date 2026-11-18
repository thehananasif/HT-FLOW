import { describe, expect, it } from 'vitest';
import type { Bar } from '@htflow/market-data';
import { RECT_STRIDE, RectBatch, joinStrips, polylineStrip } from './batch';
import { cssOf, parseColor } from './color';
import {
  buildCandles,
  buildGridLines,
  buildProfileRows,
  buildVerticalGradient,
  buildVolumeBars,
  candleBodyWidth,
  type CandleGeometryStyle,
  type Layout,
} from './geometry';
import { Canvas2DPainter, isSoftwareRenderer, resolveRenderer } from './painter';

const bar = (o: number, h: number, l: number, c: number, vol = 10): Bar =>
  ({ t: 0, o, h, l, c, vol }) as Bar;

const L: Layout = {
  i0: 0,
  i1: 1,
  slotWidth: 10,
  tickPx: 1,
  xOf: (i) => 5 + i * 10,
  yOf: (px) => 100 - px,
};

const STYLE: CandleGeometryStyle = {
  mode: 'candles',
  bodyPct: 0.6,
  strip: false,
  up: '#00ff00',
  down: '#ff0000',
  borderColor: '#888888',
  border: false,
  sameBorderAsBody: true,
  borderWidth: 1,
  direction: 'close-open',
  barWidth: 1,
  dojiColor: '',
  showOpen: true,
  showClose: true,
};

const rects = (b: RectBatch) =>
  Array.from({ length: b.count }, (_, k) => Array.from(b.data.slice(k * 8, k * 8 + 8)));

describe('colour parsing', () => {
  it('parses hex, rgba and named colours', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#0f08')[1]).toBeCloseTo(1);
    expect(parseColor('#0f08')[3]).toBeCloseTo(0x88 / 255);
    expect(parseColor('rgba(255, 128, 0, 0.5)')).toEqual([1, 128 / 255, 0, 0.5]);
    expect(parseColor('rgb(0 0 255)')).toEqual([0, 0, 1, 1]);
    expect(parseColor('transparent')[3]).toBe(0);
    expect(parseColor('nonsense')).toEqual([0, 0, 0, 1]);
    expect(cssOf(1, 0.5, 0, 0.25)).toBe('rgba(255,128,0,0.25)');
  });
});

describe('RectBatch', () => {
  it('grows, skips empty rects and multiplies alpha', () => {
    const b = new RectBatch(1);
    b.rect(0, 0, 1, 1, '#ffffff', 0.5).rect(0, 0, 0, 5, '#fff').rect(1, 1, 2, 2, '#000000');
    expect(b.count).toBe(2);
    expect(b.view().length).toBe(2 * RECT_STRIDE);
    expect(rects(b)[0]![7]).toBe(0.5);
  });

  it('outline = four edge rects', () => {
    const b = new RectBatch().outline(10, 10, 20, 10, '#fff');
    expect(b.count).toBe(4);
    const area = rects(b).reduce((s, r) => s + r[2]! * r[3]!, 0);
    expect(area).toBe(2 * 20 + 2 * 8);
  });
});

describe('geometry builders', () => {
  it('candles: one wick + one body per bar, coloured by direction', () => {
    const b = buildCandles(new RectBatch(), [bar(10, 20, 5, 15), bar(15, 16, 8, 9)], L, STYLE);
    const r = rects(b);
    expect(b.count).toBe(4);
    // Wick of bar 0: x centre 5.5, from y(20)=80 down to y(5)=95.
    expect(r[0]!.slice(0, 4)).toEqual([5, 80, 1, 15]);
    // Body of bar 0: width floor(10*0.6)=6, from y(15)=85 to y(10)=90, green.
    expect(r[1]!.slice(0, 8)).toEqual([2, 85, 6, 5, 0, 1, 0, 1]);
    expect(r[3]![4]).toBe(1); // bar 1 is down → red
    expect(candleBodyWidth(100, 0.6, true)).toBe(8);
  });

  it('OHLC bars: wick + open tick + close tick, no body', () => {
    const b = buildCandles(
      new RectBatch(),
      [bar(10, 20, 5, 15)],
      { ...L, i1: 0 },
      {
        ...STYLE,
        mode: 'bars',
      },
    );
    expect(b.count).toBe(3);
  });

  it('transparent candles outline the body', () => {
    const b = buildCandles(
      new RectBatch(),
      [bar(10, 20, 5, 15)],
      { ...L, i1: 0 },
      {
        ...STYLE,
        mode: 'transparent',
      },
    );
    expect(b.count).toBe(5);
  });

  it('volume bars are scaled to the visible maximum', () => {
    const pane = { x: 0, y: 100, w: 100, h: 56 };
    const b = buildVolumeBars(
      new RectBatch(),
      [bar(1, 2, 0, 2, 10), bar(2, 2, 0, 1, 5)],
      L,
      pane,
      '#00ff00',
      '#ff0000',
      0.5,
    );
    const r = rects(b);
    expect(r[0]![3]).toBe(50);
    expect(r[1]![3]).toBe(25);
    expect(r[0]![7]).toBe(0.5);
  });

  it('profile rows colour POC, value area and the rest', () => {
    const b = buildProfileRows(
      new RectBatch(),
      [
        [10, 100],
        [11, 50],
        [20, 10],
      ],
      100,
      L,
      {
        x0: 0,
        maxW: 40,
        rowTicks: 1,
        rowH: 1,
        pocRow: 10,
        vah: 11,
        val: 10,
        poc: '#ffffff',
        inside: '#00ff00',
        outside: '#0000ff',
        top: 0,
        bottom: 200,
      },
    );
    const r = rects(b);
    expect(r.map((x) => x[2])).toEqual([40, 20, 4]);
    expect(r[0]!.slice(4)).toEqual([1, 1, 1, 1]);
    expect(r[1]![5]).toBe(1);
    expect(r[2]![6]).toBe(1);
  });

  it('grid lines and gradient bands', () => {
    const plot = { x: 10, y: 0, w: 100, h: 50 };
    const g = buildGridLines(new RectBatch(), plot, [20.3], [40.7], '#333333', 1);
    expect(rects(g).map((r) => r.slice(0, 4))).toEqual([
      [10, 20, 100, 1],
      [41, 0, 1, 50],
    ]);
    const bands = buildVerticalGradient(new RectBatch(), plot, '#000000', '#ffffff', 4);
    expect(bands.count).toBe(4);
    expect(rects(bands)[3]![4]).toBe(1);
  });
});

describe('polyline strips', () => {
  it('two vertices per point, offset by half the width', () => {
    const s = polylineStrip([0, 0, 10, 0], 2, 2);
    expect(Array.from(s)).toEqual([0, 1, 0, -1, 10, 1, 10, -1]);
    expect(polylineStrip([0, 0], 1, 2).length).toBe(0);
  });

  it('joins runs with degenerate triangles', () => {
    const a = polylineStrip([0, 0, 10, 0], 2, 2);
    const b = polylineStrip([20, 0, 30, 0], 2, 2);
    const j = joinStrips([a, b]);
    expect(j.length).toBe(a.length + b.length + 4);
  });
});

describe('backend selection', () => {
  it('auto picks WebGL2 only on a hardware GPU', () => {
    expect(resolveRenderer('auto', { webgl2: true, hardware: true })).toBe('webgl2');
    expect(resolveRenderer('auto', { webgl2: true, hardware: false })).toBe('canvas2d');
    expect(resolveRenderer('webgl2', { webgl2: true, hardware: false })).toBe('webgl2');
    expect(resolveRenderer('webgl2', { webgl2: false, hardware: false })).toBe('canvas2d');
    expect(resolveRenderer('webgl2', { webgl2: true, hardware: true }, true)).toBe('canvas2d');
    expect(resolveRenderer('canvas2d', { webgl2: true, hardware: true })).toBe('canvas2d');
    expect(isSoftwareRenderer('Google SwiftShader')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (NVIDIA GeForce RTX 3070)')).toBe(false);
  });

  it('Canvas2D replays the same rects with fillRect', () => {
    const calls: unknown[][] = [];
    const ctx = {
      fillStyle: '',
      fillRect: (...a: number[]) => calls.push([ctx.fillStyle, ...a]),
    } as unknown as CanvasRenderingContext2D & { fillStyle: string };
    const b = buildCandles(new RectBatch(), [bar(10, 20, 5, 15)], { ...L, i1: 0 }, STYLE);
    new Canvas2DPainter(ctx).rects(b);
    expect(calls).toEqual([
      ['rgba(0,255,0,1)', 5, 80, 1, 15],
      ['rgba(0,255,0,1)', 2, 85, 6, 5],
    ]);
  });
});
