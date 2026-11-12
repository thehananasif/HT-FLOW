import { describe, expect, it } from 'vitest';
import { BarSeries, type Instrument, type Trade } from '@htflow/market-data';
import type { ChartView } from '@htflow/chart-engine';
import {
  anchorAt,
  anchoredVwap,
  barRange,
  createDrawing,
  deserialize,
  distToSeg,
  DrawingController,
  extendSegment,
  History,
  hitShapes,
  isTool,
  pointInPoly,
  positionStats,
  rangeStats,
  serialize,
  TimeAxis,
  toolDef,
  TOOLS,
  type ControllerHost,
  type Drawing,
  type Proj,
  type ToolId,
} from './index';

const inst: Instrument = {
  id: 'mock:X',
  symbol: 'X',
  displayName: 'X',
  exchange: 'T',
  assetClass: 'futures',
  tickSize: 0.25,
  pricePrecision: 2,
  qtyPrecision: 0,
  tickValue: 12.5,
  currency: 'USD',
} as unknown as Instrument;

function trades(): Trade[] {
  const out: Trade[] = [];
  let id = 1;
  for (let m = 0; m < 30; m++)
    for (let k = 0; k < 4; k++)
      out.push({
        ts: m * 60_000 + k * 10_000,
        px: 1000 + m + k,
        qty: 2,
        side: k % 2 ? 'buy' : 'sell',
        id: id++,
      });
  return out;
}

function axisOf(series: BarSeries, ms?: number) {
  return new TimeAxis(
    () => series.bars.length,
    (i) => series.bars[i]!.t,
    () => ms,
  );
}

/** 10 px per slot, 2 px per tick, plot 600×400 at the origin; slot 0 centre at x = 5. */
function proj(series: BarSeries, ms = 60_000): Proj {
  const axis = axisOf(series, ms);
  const xOfSlot = (s: number) => 5 + s * 10;
  return {
    x: (t) => xOfSlot(axis.slotOf(t)),
    y: (px) => 400 - (px - 950) * 2,
    t: (x) => axis.timeOf((x - 5) / 10),
    px: (y) => 950 + (400 - y) / 2,
    slotAtX: (x) => (x - 5) / 10,
    xOfSlot,
    axis,
    plot: { x: 0, y: 0, w: 600, h: 400 },
    slotWidth: 10,
    tickPx: 2,
    bars: series.bars,
    barsVersion: series.version,
    inst,
    colors: {
      up: '#0f0',
      down: '#f00',
      text: '#fff',
      textSecondary: '#888',
      bg: '#000',
      surface: '#111',
      warning: '#ff0',
      info: '#00f',
    },
    measure: (t, size) => t.length * size * 0.6,
    fmtPrice: (px) => (px * 0.25).toFixed(2),
    fmtTime: (t) => String(t),
  };
}

describe('TimeAxis', () => {
  const m1 = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
  const m5 = BarSeries.build({ kind: 'time', ms: 300_000 }, trades());

  it('round-trips time ↔ slot inside, before and after the data', () => {
    const ax = axisOf(m1, 60_000);
    for (const t of [
      -600_000,
      0,
      30_000,
      12 * 60_000 + 15_000,
      29 * 60_000 + 59_000,
      3_600_000 * 5,
    ])
      expect(ax.timeOf(ax.slotOf(t))).toBeCloseTo(t, 3);
    expect(ax.slotOf(0)).toBeCloseTo(-0.5);
    expect(ax.slotOf(30_000)).toBeCloseTo(0);
    expect(ax.slotOf(31 * 60_000)).toBeCloseTo(30.5); // one bar into the future
  });

  it('keeps an anchor inside the bar that contains its time when the timeframe changes', () => {
    const t = 12 * 60_000 + 30_000; // centre of the 13th M1 bar
    expect(Math.round(axisOf(m1, 60_000).slotOf(t))).toBe(12);
    const s5 = axisOf(m5, 300_000).slotOf(t);
    expect(Math.round(s5)).toBe(2); // the 10:00–15:00 bar
    expect(s5).toBeCloseTo(2 - 0.5 + 2.5 / 5);
  });

  it('estimates the slot duration for non-time bars and handles gaps', () => {
    const tick = BarSeries.build({ kind: 'tick', n: 4 }, trades());
    const ax = axisOf(tick);
    expect(ax.duration()).toBe(60_000);
    const gap = new TimeAxis(
      () => 3,
      (i) => [0, 60_000, 600_000][i]!,
    );
    expect(gap.slotOf(330_000)).toBeCloseTo(1); // middle of the stretched second slot
    expect(gap.indexAt(-1)).toBe(-1);
    expect(gap.indexAt(700_000)).toBe(2);
  });
});

describe('geometry and hit-testing', () => {
  it('measures distances and polygons', () => {
    expect(distToSeg(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distToSeg(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(pointInPoly(5, 5, [0, 0, 10, 0, 10, 10, 0, 10])).toBe(true);
    expect(pointInPoly(15, 5, [0, 0, 10, 0, 10, 10, 0, 10])).toBe(false);
  });

  it('extends lines to the plot', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(extendSegment(10, 50, 20, 50, box, false, true)).toEqual([10, 50, 100, 50]);
    expect(extendSegment(10, 50, 20, 50, box, true, true)).toEqual([0, 50, 100, 50]);
    expect(extendSegment(10, 150, 20, 150, box, true, true)).toBeNull();
  });

  it('hits a trend line near the stroke and a filled rectangle inside', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    const line = createDrawing('trend-line', [
      { t: P.t(100), px: P.px(100) },
      { t: P.t(300), px: P.px(300) },
    ]);
    const shapes = toolDef('trend-line')!.build(line, P);
    expect(hitShapes(shapes, 200, 202, 5, P.measure)).toBe(true);
    expect(hitShapes(shapes, 200, 240, 5, P.measure)).toBe(false);
    const def = toolDef('rectangle')!;
    const rect = createDrawing(
      'rectangle',
      [
        { t: P.t(100), px: P.px(100) },
        { t: P.t(300), px: P.px(300) },
      ],
      def.defaults,
    );
    expect(hitShapes(def.build(rect, P), 200, 150, 5, P.measure)).toBe(true);
    expect(hitShapes(def.build(rect, P), 400, 150, 5, P.measure)).toBe(false);
  });

  it('every ready tool builds shapes without throwing', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    for (const def of TOOLS.filter((t) => t.ready && !t.command)) {
      const n = def.mode === 'click' ? 1 : Math.max(2, def.n || 4);
      const anchors = Array.from({ length: n }, (_, i) => ({
        t: (3 + i * 4) * 60_000,
        px: 1010 + ((i * 7) % 15),
      }));
      const d = createDrawing(def.id, def.screen ? [{ t: 0.5, px: 0.5 }] : anchors, def.defaults);
      def.init?.(d, P);
      const shapes = def.build(d, P);
      expect(shapes.length, def.id).toBeGreaterThan(0);
      for (const sh of shapes)
        if (sh.k === 'path') expect(sh.pts.every(Number.isFinite), def.id).toBe(true);
    }
  });
});

describe('magnet and snapping', () => {
  const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
  const P = proj(s);
  it('snaps to the high of the bar under the cursor within the sensitivity', () => {
    const bar = s.bars[10]!;
    const a = anchorAt(P, P.xOfSlot(10) + 3, P.y(bar.h) - 5, {
      magnet: true,
      px: 8,
      snapTicks: true,
    });
    expect(a.px).toBe(bar.h);
    expect(a.t).toBeCloseTo(10 * 60_000 + 30_000);
  });
  it('only rounds to ticks when the magnet is off or out of range', () => {
    const a = anchorAt(P, 200, P.y(1200.4), { magnet: true, px: 8, snapTicks: true });
    expect(a.px).toBe(1200);
    const b = anchorAt(P, 200, P.y(1200.4), { magnet: false, px: 8, snapTicks: false });
    expect(b.px).toBeCloseTo(1200.4);
  });
});

describe('measurement, risk and volume maths', () => {
  const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
  it('ruler: bars, time, ticks, points, %, $ and volume/delta from clusters', () => {
    const st = rangeStats(
      inst,
      { t: 0, px: 1000, slot: 0 },
      { t: 5 * 60_000 - 1, px: 1010, slot: 5 },
      s.bars,
    );
    expect(st.bars).toBe(5);
    expect(st.ticks).toBe(10);
    expect(st.points).toBe(2.5);
    expect(st.pct).toBeCloseTo(1);
    expect(st.value).toBe(125);
    expect(st.volume).toBe(5 * 4 * 2); // bars 0..4, every print is inside 1000..1010
    expect(st.delta).toBe(0);
  });
  it('bar range, position stats and anchored VWAP', () => {
    expect(barRange(s.bars, 90_000, 200_000)).toEqual({ i0: 1, i1: 3 });
    const p = positionStats(inst, 'long', 1000, 1020, 990, 1, 500);
    expect(p.rr).toBe(2);
    expect(p.qty).toBe(4); // 500 / (10 ticks × 12.5)
    expect(p.profit).toBe(20 * 12.5 * 4);
    const sh = positionStats(inst, 'short', 1000, 980, 1010, 2);
    expect(sh.tpTicks).toBe(20);
    expect(sh.loss).toBe(10 * 12.5 * 2);
    const v = anchoredVwap(s.bars, 0);
    expect(v[0]!.vwap).toBeCloseTo(1001.5);
    expect(v.length).toBe(30);
  });
});

describe('serialisation and history', () => {
  it('round-trips and drops invalid entries', () => {
    const d = createDrawing('horizontal-line', [{ t: 1, px: 2 }]);
    const back = deserialize(JSON.parse(JSON.stringify(serialize([d]))), isTool);
    expect(back).toEqual([d]);
    expect(
      deserialize(
        {
          items: [{ type: 'nope', anchors: [{ t: 1, px: 1 }] }, null, { type: 'ray', anchors: [] }],
        },
        isTool,
      ),
    ).toEqual([]);
    expect(deserialize(undefined)).toEqual([]);
  });
  it('undo / redo', () => {
    const h = new History();
    const a: Drawing[] = [];
    const b = [createDrawing('dot', [{ t: 1, px: 1 }])];
    h.push(a);
    expect(h.undo(b)).toBe(a);
    expect(h.redo(a)).toBe(b);
    expect(h.undo(b)).toBe(a);
    expect(h.undo(a)).toBeNull();
  });
});

describe('DrawingController', () => {
  function setup() {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    let items: Drawing[] = [];
    let tool: ToolId | null = null;
    let selected: string | null = null;
    const host: ControllerHost = {
      items: () => items,
      save: (n) => (items = n),
      tool: () => tool,
      setTool: (t) => (tool = t),
      keepDrawing: () => false,
      magnet: () => ({ magnet: false, px: 8, snapTicks: true }),
      proj: () => P,
      selected: () => selected,
      select: (id) => (selected = id),
      tfKey: () => 't60000',
      invalidate: () => {},
    };
    const c = new DrawingController(host);
    const v = { plot: P.plot } as ChartView;
    const e = {} as MouseEvent;
    return {
      c,
      v,
      e,
      P,
      items: () => items,
      setTool: (t: ToolId | null) => (tool = t),
      tool: () => tool,
      selected: () => selected,
    };
  }

  it('creates a horizontal line with one click and a rectangle by dragging', () => {
    const t = setup();
    t.setTool('horizontal-line');
    expect(t.c.onDown(t.v, 100, 100, t.e)).toBe(true);
    t.c.onUp(t.v, 100, 100);
    expect(t.items().map((d) => d.type)).toEqual(['horizontal-line']);
    expect(t.items()[0]!.anchors[0]!.px).toBe(1100);
    expect(t.tool()).toBeNull();
    t.setTool('rectangle');
    t.c.onDown(t.v, 200, 100, t.e);
    t.c.onMove(t.v, 300, 200, t.e, true);
    t.c.onUp(t.v, 300, 200);
    expect(t.items().map((d) => d.type)).toEqual(['horizontal-line', 'rectangle']);
    expect(t.items()[1]!.anchors[1]!.px).toBe(1050);
    expect(t.selected()).toBe(t.items()[1]!.id);
  });

  it('click-click creation, select, move, delete, undo and redo', () => {
    const t = setup();
    t.setTool('trend-line');
    t.c.onDown(t.v, 100, 100, t.e);
    t.c.onUp(t.v, 100, 100);
    expect(t.c.creating).toBe(true);
    t.c.onMove(t.v, 200, 200, t.e, false);
    t.c.onDown(t.v, 200, 200, t.e);
    t.c.onUp(t.v, 200, 200);
    expect(t.items()).toHaveLength(1);
    const before = t.items()[0]!.anchors[0]!;
    // drag the body by 40 px right (4 slots) and 20 px down (10 ticks)
    expect(t.c.onDown(t.v, 150, 150, t.e)).toBe(true);
    t.c.onMove(t.v, 190, 170, t.e, true);
    t.c.onUp(t.v, 190, 170);
    const after = t.items()[0]!.anchors[0]!;
    expect(after.px).toBe(before.px - 10);
    expect(after.t - before.t).toBeCloseTo(4 * 60_000);
    // clicking empty space deselects and lets the chart pan
    expect(t.c.onDown(t.v, 500, 50, t.e)).toBe(false);
    expect(t.selected()).toBeNull();
    t.c.onDown(t.v, 190, 170, t.e);
    t.c.onUp(t.v, 190, 170);
    expect(t.c.onKey({ key: 'Delete' } as KeyboardEvent)).toBe(true);
    expect(t.items()).toHaveLength(0);
    t.c.undo();
    expect(t.items()).toHaveLength(1);
    t.c.undo();
    expect(t.items()[0]!.anchors[0]).toEqual(before);
    t.c.redo();
    expect(t.items()[0]!.anchors[0]).toEqual(after);
  });

  it('Esc cancels a drawing in progress; locked drawings do not move', () => {
    const t = setup();
    t.setTool('triangle');
    t.c.onDown(t.v, 100, 100, t.e);
    t.c.onKey({ key: 'Escape' } as KeyboardEvent);
    expect(t.c.creating).toBe(false);
    expect(t.items()).toHaveLength(0);
    t.setTool('horizontal-line');
    t.c.onDown(t.v, 100, 100, t.e);
    t.c.update(t.items()[0]!.id, (d) => ({ ...d, locked: true }));
    t.c.onDown(t.v, 300, 100, t.e);
    t.c.onMove(t.v, 300, 200, t.e, true);
    t.c.onUp(t.v, 300, 200);
    expect(t.items()[0]!.anchors[0]!.px).toBe(1100);
    expect(t.c.removeSelected()).toBe(false);
  });
});
