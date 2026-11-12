import { describe, expect, it } from 'vitest';
import { BarSeries, type Instrument, type Trade } from '@htflow/market-data';
import type { ChartView } from '@htflow/chart-engine';
import {
  alertChannels,
  alertShape,
  alertTrigger,
  createDrawing,
  cvdCorrelation,
  deleteGroup,
  detectAlert,
  DrawingController,
  insideZone,
  pearson,
  selectInBox,
  styleGroup,
  supportsAlert,
  TimeAxis,
  toggleSelection,
  toolDef,
  translateGroup,
  triggersFor,
  zigzag,
  type ControllerHost,
  type Drawing,
  type Proj,
  type ToolId,
} from './index';

const inst = {
  id: 'mock:X',
  symbol: 'X',
  tickSize: 0.25,
  pricePrecision: 2,
  tickValue: 12.5,
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

/** 10 px per slot, 2 px per tick, plot 600×400. */
function proj(series: BarSeries): Proj {
  const axis = new TimeAxis(
    () => series.bars.length,
    (i) => series.bars[i]!.t,
    () => 60_000,
  );
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

const mk = (type: ToolId, anchors: { t: number; px: number }[], over: Partial<Drawing> = {}) => ({
  ...createDrawing(type, anchors),
  ...over,
});

describe('alert on cross geometry', () => {
  it('horizontal line fires once per crossing, with direction', () => {
    const d = mk('horizontal-line', [{ t: 0, px: 100 }]);
    expect(detectAlert(d, { t: 1, px: 99 }, { t: 2, px: 101 })).toEqual({
      kind: 'cross-up',
      level: 100,
    });
    expect(detectAlert(d, { t: 1, px: 101 }, { t: 2, px: 99 })?.kind).toBe('cross-down');
    expect(detectAlert(d, { t: 1, px: 101 }, { t: 2, px: 105 })).toBeNull();
    // touching the level from below counts (>=)
    expect(detectAlert(d, { t: 1, px: 99 }, { t: 2, px: 100 })?.kind).toBe('cross-up');
  });

  it('horizontal ray only exists to the right of its anchor', () => {
    const d = mk('horizontal-ray', [{ t: 1000, px: 100 }]);
    expect(detectAlert(d, { t: 500, px: 99 }, { t: 900, px: 101 })).toBeNull();
    expect(detectAlert(d, { t: 1100, px: 99 }, { t: 1200, px: 101 })?.kind).toBe('cross-up');
  });

  it('trend line crosses on the sloped price, not the anchor price', () => {
    // 100 → 200 over t 0..1000: at t = 500 the line is at 150
    const d = mk('trend-line', [
      { t: 0, px: 100 },
      { t: 1000, px: 200 },
    ]);
    expect(detectAlert(d, { t: 400, px: 130 }, { t: 500, px: 151 })).toMatchObject({
      kind: 'cross-up',
    });
    expect(detectAlert(d, { t: 400, px: 130 }, { t: 500, px: 140 })).toBeNull();
    // beyond the right end a plain segment does not exist ...
    expect(detectAlert(d, { t: 1500, px: 100 }, { t: 1600, px: 300 })).toBeNull();
    // ... until it is extended right
    const ext = { ...d, extendRight: true };
    expect(detectAlert(ext, { t: 1500, px: 100 }, { t: 1600, px: 300 })?.kind).toBe('cross-up');
  });

  it('ray extends right only; extended line both ways', () => {
    const a = [
      { t: 0, px: 100 },
      { t: 1000, px: 100 },
    ];
    const ray = mk('ray', a, { extendRight: true });
    expect(detectAlert(ray, { t: -300, px: 90 }, { t: -200, px: 110 })).toBeNull();
    expect(detectAlert(ray, { t: 2000, px: 90 }, { t: 2100, px: 110 })?.kind).toBe('cross-up');
    const ext = mk('extended-line', a);
    expect(detectAlert(ext, { t: -300, px: 90 }, { t: -200, px: 110 })?.kind).toBe('cross-up');
  });

  it('channel: boundary crossing and enter / exit of the band', () => {
    // base line flat at 100, third anchor at 120 → band 100..120
    const ch = mk('parallel-channel', [
      { t: 0, px: 100 },
      { t: 1000, px: 100 },
      { t: 500, px: 120 },
    ]);
    expect(triggersFor('parallel-channel')).toContain('enter');
    expect(alertTrigger(ch)).toBe('cross');
    expect(detectAlert(ch, { t: 300, px: 90 }, { t: 400, px: 105 })).toMatchObject({
      kind: 'cross-up',
      level: 100,
    });
    expect(detectAlert(ch, { t: 300, px: 110 }, { t: 400, px: 125 })).toMatchObject({
      kind: 'cross-up',
      level: 120,
    });
    const enter = { ...ch, props: { alertOn: 'enter' } };
    expect(detectAlert(enter, { t: 300, px: 90 }, { t: 400, px: 105 })?.kind).toBe('enter');
    expect(detectAlert(enter, { t: 300, px: 110 }, { t: 400, px: 125 })).toBeNull();
    const exit = { ...ch, props: { alertOn: 'exit' } };
    expect(detectAlert(exit, { t: 300, px: 110 }, { t: 400, px: 125 })?.kind).toBe('exit');
    expect(insideZone(ch, { t: 500, px: 110 })).toBe(true);
    expect(insideZone(ch, { t: 500, px: 130 })).toBe(false);
  });

  it('rectangle: enter, exit and both; leaving through the time edge counts as exit', () => {
    const r = mk('rectangle', [
      { t: 1000, px: 100 },
      { t: 2000, px: 120 },
    ]);
    expect(alertShape('rectangle')).toBe('zone');
    expect(alertTrigger(r)).toBe('enter');
    expect(detectAlert(r, { t: 1100, px: 90 }, { t: 1200, px: 110 })).toMatchObject({
      kind: 'enter',
      level: 100,
    });
    expect(detectAlert(r, { t: 1100, px: 110 }, { t: 1200, px: 125 })).toBeNull();
    const both = { ...r, props: { alertOn: 'enter-exit' } };
    expect(detectAlert(both, { t: 1100, px: 110 }, { t: 1200, px: 125 })).toMatchObject({
      kind: 'exit',
      level: 120,
    });
    expect(detectAlert(both, { t: 1900, px: 110 }, { t: 2100, px: 110 })?.kind).toBe('exit');
    expect(detectAlert(both, { t: 1100, px: 110 }, { t: 1200, px: 111 })).toBeNull();
  });

  it('only supported tools alert; channels default to all on', () => {
    expect(supportsAlert('trend-line')).toBe(true);
    expect(supportsAlert('fib-retracement')).toBe(false);
    const d = mk('ray', [{ t: 0, px: 1 }]);
    expect(alertChannels(d)).toEqual({ toast: true, sound: true, log: true, once: true });
    const off = { ...d, props: { alertSound: false, alertOnce: false } };
    expect(alertChannels(off)).toMatchObject({ sound: false, once: false, toast: true });
  });
});

describe('multi-selection', () => {
  function setup() {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    let items: Drawing[] = [];
    let tool: ToolId | null = null;
    let multi: string[] = [];
    const host: ControllerHost = {
      items: () => items,
      save: (n) => (items = n),
      tool: () => tool,
      setTool: (t) => (tool = t),
      keepDrawing: () => false,
      magnet: () => ({ magnet: false, px: 8, snapTicks: true }),
      proj: () => P,
      selected: () => multi[multi.length - 1] ?? null,
      select: (id) => (multi = id ? [id] : []),
      selectedIds: () => multi,
      selectMany: (ids) => (multi = ids),
      tfKey: () => 't60000',
      invalidate: () => {},
    };
    const c = new DrawingController(host);
    const v = { plot: P.plot } as ChartView;
    const plain = {} as MouseEvent;
    const shift = { shiftKey: true } as MouseEvent;
    const ctrl = { ctrlKey: true } as MouseEvent;
    // three horizontal lines at y = 100, 200, 300 (px 1100, 1050, 1000)
    items = [100, 200, 300].map((y, i) =>
      createDrawing('horizontal-line', [{ t: P.t(50), px: P.px(y) }], {}, i + 1),
    );
    return { c, v, P, plain, shift, ctrl, items: () => items, sel: () => multi };
  }

  it('toggleSelection adds and removes ids', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('Shift+click builds a selection and toggles members off', () => {
    const t = setup();
    t.c.onDown(t.v, 300, 100, t.plain);
    t.c.onUp(t.v, 300, 100);
    expect(t.sel()).toHaveLength(1);
    expect(t.c.onDown(t.v, 300, 200, t.shift)).toBe(true);
    t.c.onUp(t.v, 300, 200);
    expect(t.sel()).toEqual([t.items()[0]!.id, t.items()[1]!.id]);
    t.c.onDown(t.v, 300, 100, t.shift);
    expect(t.sel()).toEqual([t.items()[1]!.id]);
    // plain click on another drawing replaces the selection
    t.c.onDown(t.v, 300, 300, t.plain);
    t.c.onUp(t.v, 300, 300);
    expect(t.sel()).toEqual([t.items()[2]!.id]);
  });

  it('Ctrl+drag on empty space box-selects what the rectangle touches', () => {
    const t = setup();
    expect(t.c.onDown(t.v, 20, 150, t.ctrl)).toBe(true);
    t.c.onMove(t.v, 580, 250, t.ctrl, true);
    expect(t.c.boxRect()).toMatchObject({ x0: 20, y0: 150, x1: 580, y1: 250 });
    t.c.onUp(t.v, 580, 250);
    expect(t.c.boxRect()).toBeNull();
    expect(t.sel()).toEqual([t.items()[1]!.id]);
    // box over everything
    t.c.onDown(t.v, 5, 50, t.ctrl);
    t.c.onMove(t.v, 590, 350, t.ctrl, true);
    t.c.onUp(t.v, 590, 350);
    expect(t.sel()).toHaveLength(3);
    expect(selectInBox(t.items(), t.P, { x0: 0, y0: 0, x1: 600, y1: 150 })).toEqual([
      t.items()[0]!.id,
    ]);
  });

  it('dragging one member moves the whole group in one undo step; locked members stay', () => {
    const t = setup();
    const lockedId = t.items()[2]!.id;
    t.c.update(lockedId, (d) => ({ ...d, locked: true }));
    const before = t.items().map((d) => d.anchors[0]!.px);
    t.c.host.selectMany!([t.items()[0]!.id, t.items()[1]!.id, lockedId]);
    t.c.onDown(t.v, 300, 100, t.plain);
    t.c.onMove(t.v, 300, 120, t.plain, true);
    t.c.onUp(t.v, 300, 120);
    const after = t.items().map((d) => d.anchors[0]!.px);
    expect(after[0]).toBe(before[0]! - 10);
    expect(after[1]).toBe(before[1]! - 10);
    expect(after[2]).toBe(before[2]);
    expect(t.sel()).toHaveLength(3);
    expect(t.c.undo()).toBe(true);
    expect(t.items().map((d) => d.anchors[0]!.px)).toEqual(before);
  });

  it('Del removes the group except locked drawings; undo restores it', () => {
    const t = setup();
    const ids = t.items().map((d) => d.id);
    t.c.update(ids[2]!, (d) => ({ ...d, locked: true }));
    t.c.host.selectMany!(ids);
    expect(t.c.onKey({ key: 'Delete' } as KeyboardEvent)).toBe(true);
    expect(t.items().map((d) => d.id)).toEqual([ids[2]]);
    t.c.undo();
    expect(t.items()).toHaveLength(3);
  });

  it('group helpers: translate, delete and style', () => {
    const t = setup();
    const ids = new Set([t.items()[0]!.id, t.items()[1]!.id]);
    const moved = translateGroup(t.items(), ids, t.P, 0, 20, 100, true);
    expect(moved[0]!.anchors[0]!.px).toBe(t.items()[0]!.anchors[0]!.px - 10);
    expect(moved[2]).toBe(t.items()[2]);
    expect(deleteGroup(t.items(), ids)).toHaveLength(1);
    const styled = styleGroup(t.items(), ids, { color: '#FF0000', width: 3 });
    expect(styled.filter((d) => d.style.color === '#FF0000')).toHaveLength(2);
    expect(styled[2]!.style.width).toBe(1);
  });
});

describe('zigzag + CVD correlation + new tools', () => {
  const bar = (i: number, h: number, l: number, c: number, delta: number) =>
    ({
      t: i * 60_000,
      tEnd: i * 60_000,
      o: c,
      h,
      l,
      c,
      vol: 10,
      buy: 5,
      sell: 5,
      delta,
      maxDelta: 0,
      minDelta: 0,
      trades: 1,
      clusters: new Map([
        [Math.round((h + l) / 2), { bid: 5, ask: 5 }],
        [Math.round(l), { bid: 2, ask: 3 }],
      ]),
      closed: true,
    }) as unknown as Parameters<typeof zigzag>[0][number];

  const up = [100, 110, 120, 130, 125, 115, 105, 112, 125, 140].map((p, i) =>
    bar(i, p + 2, p - 2, p, i % 2 ? 3 : -1),
  );

  it('finds alternating swing highs and lows', () => {
    const z = zigzag(up, 0, up.length - 1, 15);
    expect(z.map((s) => s.dir)).toEqual([-1, 1, -1, 1]);
    expect(z[1]!.i).toBe(3);
    expect(z[2]!.i).toBe(6);
    expect(z[3]!.i).toBe(9);
    expect(zigzag(up, 0, up.length - 1, 1000)).toHaveLength(0);
  });

  it('pearson and divergence', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    const bear = [100, 105, 110, 115].map((p, i) => bar(i, p + 1, p - 1, p, -10));
    const r = cvdCorrelation(bear, 0, 3);
    expect(r.divergence).toBe('bearish');
    expect(r.corr).toBeLessThan(0);
    const bull = [115, 110, 105, 100].map((p, i) => bar(i, p + 1, p - 1, p, 10));
    expect(cvdCorrelation(bull, 0, 3).divergence).toBe('bullish');
  });

  it('new tools are ready and build shapes from bar data', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    for (const id of ['zigzag-vp', 'cvd-correlation'] as const) {
      const def = toolDef(id)!;
      expect(def.ready).toBe(true);
      const d = createDrawing(
        id,
        [
          { t: s.bars[2]!.t, px: 1010 },
          { t: s.bars[26]!.t, px: 1040 },
        ],
        def.defaults,
      );
      expect(def.build(d, P).length).toBeGreaterThan(1);
    }
    expect(toolDef('magnifier')).toMatchObject({ ready: true, command: true, shortcut: 'M' });
    expect(toolDef('remove-indicators')?.command).toBe(true);
  });

  it('regression channel draws an inner σ band when sigma2 is set', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    const def = toolDef('regression-channel')!;
    const a = [
      { t: s.bars[2]!.t, px: 1010 },
      { t: s.bars[26]!.t, px: 1040 },
    ];
    const lines = (props: Record<string, number>) =>
      def
        .build({ ...createDrawing('regression-channel', a, def.defaults), props }, P)
        .filter((x) => x.k === 'path' && !x.closed).length;
    expect(lines({ sigma: 2 })).toBe(3);
    expect(lines({ sigma: 2, sigma2: 1 })).toBe(5);
  });

  it('anchored VWAP honours both band multipliers', () => {
    const s = BarSeries.build({ kind: 'time', ms: 60_000 }, trades());
    const P = proj(s);
    const def = toolDef('anchored-vwap')!;
    const count = (props: Record<string, number>) =>
      def
        .build(
          {
            ...createDrawing('anchored-vwap', [{ t: s.bars[2]!.t, px: 1010 }], def.defaults),
            props,
          },
          P,
        )
        .filter((x) => x.k === 'path').length;
    expect(count({ band1: 1, band2: 2 })).toBe(5);
    expect(count({ band1: 0, band2: 3 })).toBe(3);
  });
});
