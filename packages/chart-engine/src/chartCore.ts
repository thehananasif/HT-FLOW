import { formatPrice, type Instrument } from '@htflow/market-data';
import { formatDateTime, formatTime, niceTimeStep } from './scale';
import { padRange, priceMapping, scaleLabel, scaleLevels, type PriceScaleMode } from './priceScale';
import { inferPeriod, realSlot, slotAtOrBefore, virtualSlot, zoneOffsetMin } from './time';
import { DEFAULT_STYLE, dashFor, pick, type ChartStyle } from './style';
import type { ChartLayer, ChartPalette, ChartView, PriceTag, Rect, SlotSource } from './types';

export type MouseMode = 'pointer' | 'crosshair' | 'zoom' | 'scroll' | 'zoomxy';
export type WheelBehavior = 'zoom-time' | 'zoom-xy' | 'scroll';
export type PriceAxisSide = 'right' | 'left' | 'both';

export interface ChartCoreOptions {
  priceAxis: boolean;
  timeAxis: boolean;
  priceAxisWidth: number;
  timeAxisHeight: number;
  /** Which side(s) show the price axis (when priceAxis is on). */
  priceAxisSide: PriceAxisSide;
  /** Empty slots kept to the right of the last slot when following live data. */
  rightMargin: number;
  minSlotWidth: number;
  maxSlotWidth: number;
  showGrid: boolean;
  autoScalePadding: number;
  fontFamily: string;
  monoFamily: string;
  /** Price scale: linear / log / percent / indexed. */
  scaleMode: PriceScaleMode;
  invertScale: boolean;
  /** Gaps on: x is proportional to time, so missing periods show as empty space. */
  gaps: boolean;
  /** Time zone of the time axis: 'local', 'UTC' or an IANA zone. */
  timeZone: string;
  wheel: WheelBehavior;
  /** Frame cap (0 = every animation frame). */
  maxFps: number;
  /** Minimum height of the main price pane when sub-panes are resized. */
  minMainHeight: number;
}

const DEFAULTS: ChartCoreOptions = {
  priceAxis: true,
  timeAxis: true,
  priceAxisWidth: 64,
  timeAxisHeight: 22,
  priceAxisSide: 'right',
  rightMargin: 4,
  minSlotWidth: 1,
  maxSlotWidth: 400,
  showGrid: true,
  autoScalePadding: 0.08,
  fontFamily: '"Geist", "Segoe UI", system-ui, sans-serif',
  monoFamily: '"Geist Mono", Consolas, monospace',
  scaleMode: 'linear',
  invertScale: false,
  gaps: false,
  timeZone: 'local',
  wheel: 'zoom-time',
  maxFps: 0,
  minMainHeight: 80,
};

/**
 * Pluggable pointer interaction (drawing tools, order dragging…). Handlers are asked in order;
 * returning true from onDown captures the pointer until mouseup and suppresses panning.
 */
export interface PointerHandler {
  onDown?(v: ChartView, x: number, y: number, e: MouseEvent): boolean;
  onMove?(v: ChartView, x: number, y: number, e: MouseEvent, captured: boolean): void;
  onUp?(v: ChartView, x: number, y: number, e: MouseEvent): void;
  onKey?(e: KeyboardEvent): boolean;
  /** CSS cursor while hovering, or null for default. */
  cursor?(v: ChartView, x: number, y: number): string | null;
}

export interface PriceRangeListener {
  (min: number, max: number): void;
}

/** Crosshair position shared between charts (time + price), or null when the mouse left. */
export interface CrosshairPoint {
  t: number;
  px: number;
  slot: number;
}

/** What is under a point (context-aware menus). */
export interface HitInfo {
  area: 'plot' | 'price-axis' | 'time-axis' | 'pane' | 'separator' | 'gutter' | 'other';
  /** Sub-pane layer id for 'pane' / 'separator'. */
  layerId?: string;
}

interface PaneRect {
  layer: ChartLayer;
  y: number;
  h: number;
}

/**
 * ChartCore — one renderer, many views (fast-track rule 3). Owns the canvas, x/y scales,
 * pan/zoom, crosshair and axes; everything chart-specific is a ChartLayer.
 * Redraws only when invalidated, at most once per animation frame.
 */
export class ChartCore {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  layers: ChartLayer[] = [];
  options: ChartCoreOptions;
  palette: ChartPalette;
  style: ChartStyle = structuredClone(DEFAULT_STYLE);
  instrument: Instrument;
  source: SlotSource = { count: () => 0, timeAt: () => 0 };
  /** Close (ticks) of slot i — base for percent / indexed scales and crosshair snapping. */
  valueAt: ((i: number) => number | null) | null = null;

  slotWidth = 10;
  /** Distance (in slots) from the last slot to the right edge; >= 0 means following live. */
  rightOffset: number;
  autoScale = true;
  priceMin = 0;
  priceMax = 1;
  mouseMode: MouseMode = 'crosshair';
  /** When set, the y-scale follows another chart (Order Flow split view). */
  linkedPrice: ChartCore | null = null;
  /** Debug overlay with fps (Settings → Show debug info). */
  showDebug = false;
  /** Drawing tools, order dragging and other interactions (see PointerHandler). */
  pointerHandlers: PointerHandler[] = [];
  /** User-dragged sub-pane heights by layer id (layers without setBottomHeight). */
  paneHeights = new Map<string, number>();
  /** Sub-pane shown maximised (takes most of the height), or null. */
  maximizedPane: string | null = null;
  /** Crosshair from another chart (sync / global crosshair). */
  externalCrosshair: CrosshairPoint | null = null;
  /** Draw the horizontal line of the external crosshair (same instrument only). */
  externalShowsPrice = true;
  private captured: PointerHandler | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private dirty = true;
  private raf = 0;
  private lastFrame = 0;
  private crosshair: { x: number; y: number } | null = null;
  private drag: null | {
    kind: 'pan' | 'price-axis' | 'time-axis' | 'zoom-box' | 'separator';
    x: number;
    y: number;
    slotWidth: number;
    rightOffset: number;
    pmin: number;
    pmax: number;
    shift: boolean;
    layerId?: string;
    h0?: number;
  } = null;
  private zoomBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private ro: ResizeObserver | null = null;
  private lastView: ChartView | null = null;
  private frameTimes: number[] = [];
  private priceListeners = new Set<PriceRangeListener>();
  private crosshairListeners = new Set<(c: CrosshairPoint | null) => void>();
  private paneListeners = new Set<(layerId: string, h: number) => void>();
  private pastStartListeners = new Set<(slotsPast: number) => void>();
  private periodCache = { n: -1, period: 0 };
  private destroyed = false;
  private abort = new AbortController();

  constructor(
    readonly host: HTMLElement,
    instrument: Instrument,
    palette: ChartPalette,
    options: Partial<ChartCoreOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.instrument = instrument;
    this.palette = palette;
    this.rightOffset = this.options.rightMargin;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bindEvents();
    this.loop();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.abort.abort();
    this.canvas.remove();
  }

  invalidate(): void {
    this.dirty = true;
  }

  setLayers(layers: ChartLayer[]): void {
    this.layers = layers;
    this.invalidate();
  }

  setPalette(p: ChartPalette): void {
    this.palette = p;
    this.invalidate();
  }

  setInstrument(inst: Instrument): void {
    this.instrument = inst;
    this.autoScale = true;
    this.invalidate();
  }

  setSource(src: SlotSource): void {
    this.source = src;
    this.periodCache.n = -1;
    this.invalidate();
  }

  setOptions(o: Partial<ChartCoreOptions>): void {
    const scaleChanged =
      (o.scaleMode && o.scaleMode !== this.options.scaleMode) ||
      (o.invertScale !== undefined && o.invertScale !== this.options.invertScale);
    this.options = { ...this.options, ...o };
    if (scaleChanged) this.autoScale = true;
    this.invalidate();
  }

  setStyle(s: ChartStyle): void {
    this.style = s;
    this.invalidate();
  }

  onPriceRange(fn: PriceRangeListener): () => void {
    this.priceListeners.add(fn);
    return () => this.priceListeners.delete(fn);
  }

  /** Local crosshair moves (null when the pointer leaves) — for sync / global crosshair. */
  onCrosshairMove(fn: (c: CrosshairPoint | null) => void): () => void {
    this.crosshairListeners.add(fn);
    return () => this.crosshairListeners.delete(fn);
  }

  /** User resized a sub-pane (persist the height). */
  onPaneResize(fn: (layerId: string, h: number) => void): () => void {
    this.paneListeners.add(fn);
    return () => this.paneListeners.delete(fn);
  }

  /** The view is scrolled left past the first loaded slot (lazy history loading). */
  onScrollPastStart(fn: (slotsPast: number) => void): () => void {
    this.pastStartListeners.add(fn);
    return () => this.pastStartListeners.delete(fn);
  }

  setExternalCrosshair(c: CrosshairPoint | null, showPrice = true): void {
    this.externalCrosshair = c;
    this.externalShowsPrice = showPrice;
    this.invalidate();
  }

  /** Go to the latest data and re-enable auto-scale (Ctrl+R "Reset chart"). */
  reset(): void {
    this.rightOffset = this.options.rightMargin;
    this.autoScale = true;
    this.invalidate();
  }

  /** Scrolls so that slot i is centred. */
  scrollToSlot(i: number): void {
    const n = this.source.count();
    const visible = this.plotRect().w / this.slotWidth;
    this.rightOffset = this.vpos(n - 1, n) - this.vpos(i, n) - visible / 2;
    this.invalidate();
  }

  /** Scrolls so that the slot at or before time t is centred; returns false if t is before the data. */
  scrollToTime(t: number): boolean {
    const n = this.source.count();
    if (!n) return false;
    const i = slotAtOrBefore(this.source.timeAt, n, t);
    this.scrollToSlot(Math.max(0, i));
    return i >= 0;
  }

  /** Slot at or before time t (-1 if before the data). */
  slotAtTime(t: number): number {
    return slotAtOrBefore(this.source.timeAt, this.source.count(), t);
  }

  get view(): ChartView | null {
    return this.lastView;
  }

  /** Renders a PNG of the current frame (snapshot camera). */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Maximise / restore a sub-pane. */
  toggleMaximizePane(layerId: string): void {
    this.maximizedPane = this.maximizedPane === layerId ? null : layerId;
    this.invalidate();
  }

  /** Forget user pane heights (double-click a separator). */
  resetPanes(): void {
    this.paneHeights.clear();
    this.maximizedPane = null;
    this.invalidate();
  }

  /** What is under (x, y) in CSS px (context-aware menus). */
  hitTest(x: number, y: number): HitInfo {
    const v = this.lastView;
    if (!v) return { area: 'other' };
    const sep = this.separatorAt(y);
    if (sep && x < v.priceAxis.x + v.priceAxis.w) return { area: 'separator', layerId: sep };
    if (this.options.timeAxis && y >= v.timeAxis.y) return { area: 'time-axis' };
    for (const p of this.panes())
      if (y >= p.y && y < p.y + p.h) return { area: 'pane', layerId: p.layer.id };
    const h = this.hit(x, y);
    if (h === 'other' && y < v.plot.h) return { area: 'gutter' };
    return { area: h };
  }

  // ---------------------------------------------------------------- layout

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.floor(r.width));
    this.height = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.invalidate();
  }

  private paneHeight(l: ChartLayer): number {
    const want = l.bottomHeight?.() ?? 0;
    if (want <= 0) return 0;
    const o = this.paneHeights.get(l.id);
    return o !== undefined && !l.setBottomHeight ? o : want;
  }

  /** Sub-pane heights after maximise and the main-pane minimum are applied. */
  private paneHeightsNow(): Map<ChartLayer, number> {
    const out = new Map<ChartLayer, number>();
    const ta = this.options.timeAxis ? this.options.timeAxisHeight : 0;
    const avail = Math.max(0, this.height - ta);
    let total = 0;
    for (const l of this.layers) {
      const h = this.paneHeight(l);
      if (h > 0) {
        out.set(l, h);
        total += h;
      }
    }
    const max = this.maximizedPane && this.layers.find((l) => l.id === this.maximizedPane);
    if (max && out.has(max)) {
      const rest = [...out.keys()].filter((l) => l !== max);
      const small = 24;
      for (const l of rest) out.set(l, small);
      out.set(max, Math.max(40, avail - this.options.minMainHeight - rest.length * small));
      return out;
    }
    const limit = avail - this.options.minMainHeight;
    if (total > limit && total > 0 && limit > 0) {
      const k = limit / total;
      for (const [l, h] of out) out.set(l, Math.max(16, Math.floor(h * k)));
    }
    return out;
  }

  private gutters(): { left: number; right: number; bottom: number } {
    let left = 0;
    let right = 0;
    let bottom = 0;
    const ph = this.paneHeightsNow();
    for (const l of this.layers) {
      left += l.leftGutter?.() ?? 0;
      right += l.rightGutter?.() ?? 0;
      bottom += ph.get(l) ?? 0;
    }
    return { left, right, bottom };
  }

  private axisWidths(): { left: number; right: number } {
    const o = this.options;
    if (!o.priceAxis) return { left: 0, right: 0 };
    const w = o.priceAxisWidth;
    if (o.priceAxisSide === 'left') return { left: w, right: 0 };
    if (o.priceAxisSide === 'both') return { left: w, right: w };
    return { left: 0, right: w };
  }

  private plotRect(): Rect {
    const g = this.gutters();
    const aw = this.axisWidths();
    const ta = this.options.timeAxis ? this.options.timeAxisHeight : 0;
    return {
      x: g.left + aw.left,
      y: 0,
      w: Math.max(10, this.width - g.left - g.right - aw.left - aw.right),
      h: Math.max(10, this.height - ta - g.bottom),
    };
  }

  private panes(): PaneRect[] {
    const out: PaneRect[] = [];
    const plot = this.plotRect();
    const ph = this.paneHeightsNow();
    let y = plot.h;
    for (const l of this.layers) {
      const h = ph.get(l) ?? 0;
      if (h > 0) {
        out.push({ layer: l, y, h });
        y += h;
      }
    }
    return out;
  }

  private separatorAt(y: number): string | null {
    for (const p of this.panes()) if (Math.abs(y - p.y) <= 3) return p.layer.id;
    return null;
  }

  // ---------------------------------------------------------------- x mapping (gaps)

  private period(n: number): number {
    if (this.periodCache.n !== n) {
      this.periodCache = { n, period: inferPeriod(this.source.timeAt, n) };
    }
    return this.periodCache.period;
  }

  private gapsActive(n: number): boolean {
    return this.options.gaps && n > 1 && this.period(n) > 0;
  }

  /** Virtual position of slot i (equals i when gaps are off). */
  private vpos(i: number, n: number): number {
    return this.gapsActive(n) ? virtualSlot(this.source.timeAt, n, i, this.period(n)) : i;
  }

  // ---------------------------------------------------------------- frame

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty || this.width < 2) return;
    const now = performance.now();
    if (this.options.maxFps > 0 && now - this.lastFrame < 1000 / this.options.maxFps - 1) return;
    this.lastFrame = now;
    this.dirty = false;
    const t0 = performance.now();
    this.render();
    if (this.showDebug) {
      this.frameTimes.push(performance.now() - t0);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
    }
  };

  private computeView(): ChartView {
    const o = this.options;
    const g = this.gutters();
    const aw = this.axisWidths();
    const plot = this.plotRect();
    const n = this.source.count();
    const sw = this.slotWidth;
    const gaps = this.gapsActive(n);
    const period = gaps ? this.period(n) : 0;
    const timeAt = this.source.timeAt;
    // x of slot centre: last slot sits rightOffset slots from the right edge.
    const lastV = n - 1;
    const lastX = plot.x + plot.w - (this.rightOffset + 0.5) * sw;
    const xOf = gaps
      ? (i: number) => lastX - (lastV - virtualSlot(timeAt, n, i, period)) * sw
      : (i: number) => lastX - (n - 1 - i) * sw;
    const slotAt = gaps
      ? (x: number) => realSlot(timeAt, n, lastV - (lastX - x) / sw, period)
      : (x: number) => Math.round(n - 1 - (lastX - x) / sw);
    const i0 = Math.max(0, Math.floor(slotAt(plot.x)) - 1);
    const i1 = Math.min(n - 1, Math.ceil(slotAt(plot.x + plot.w)) + 1);
    const mode = o.scaleMode;

    if (this.linkedPrice) {
      this.priceMin = this.linkedPrice.priceMin;
      this.priceMax = this.linkedPrice.priceMax;
    } else if (this.autoScale && n > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of this.layers) {
        const r = l.priceRange?.(i0, i1);
        if (r) {
          if (r[0] < lo) lo = r[0];
          if (r[1] > hi) hi = r[1];
        }
      }
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        if (hi - lo < 10) {
          const c = (hi + lo) / 2;
          lo = c - 5;
          hi = c + 5;
        }
        const [a, b] = padRange(lo, hi, o.autoScalePadding, mode);
        this.priceMin = a;
        this.priceMax = b;
      }
    }
    const pmin = this.priceMin;
    const pmax = this.priceMax;
    const tickPx = plot.h / Math.max(1e-9, pmax - pmin);
    const map = priceMapping(pmin, pmax, plot.y, plot.h, mode, o.invertScale);
    const ta = o.timeAxis ? o.timeAxisHeight : 0;
    const right: Rect = { x: plot.x + plot.w, y: 0, w: g.right, h: plot.h };
    const rightAxis: Rect = { x: right.x + right.w, y: 0, w: aw.right, h: plot.h };
    const leftAxis: Rect = { x: 0, y: 0, w: aw.left, h: plot.h };
    const ch = this.crosshair;
    const font = (size: number, weight = 400, mono = false) =>
      `${weight} ${size}px ${mono ? o.monoFamily : o.fontFamily}`;
    let base = 0;
    if (this.valueAt && n > 0) base = this.valueAt(Math.min(n - 1, Math.max(0, i0 + 1))) ?? 0;
    let crosshair: ChartView['crosshair'] = null;
    if (ch) {
      const slot = slotAt(ch.x);
      let y = ch.y;
      if (this.style.crosshair.snap && this.valueAt && slot >= 0 && slot < n && y < plot.h) {
        const c = this.valueAt(slot);
        if (c !== null) y = map.yOf(c);
      }
      crosshair = { x: ch.x, y, slot, px: Math.round(map.pxAt(y)) };
    }
    return {
      ctx: this.ctx,
      palette: this.palette,
      instrument: this.instrument,
      width: this.width,
      height: this.height,
      plot,
      left: { x: aw.left, y: 0, w: g.left, h: plot.h },
      right,
      bottom: { x: plot.x, y: plot.h, w: plot.w, h: g.bottom },
      priceAxis: aw.right > 0 || aw.left === 0 ? rightAxis : leftAxis,
      timeAxis: { x: plot.x, y: this.height - ta, w: plot.w, h: ta },
      i0,
      i1,
      slotCount: n,
      slotWidth: sw,
      tickPx,
      priceMin: pmin,
      priceMax: pmax,
      xOf,
      slotAt,
      yOf: map.yOf,
      pxAt: map.pxAt,
      crosshair,
      tags: [],
      font,
      scaleMode: mode,
      inverted: o.invertScale,
      baseValue: base,
      timeAt,
    };
  }

  private tzOffset = (t: number): number => zoneOffsetMin(this.options.timeZone, t);

  /** Formats an axis time label in the chart's time zone. */
  formatAxisTime(t: number, step: number): string {
    const s = formatTime(t, step, this.tzOffset(t));
    return this.style.timeFormat === '12h' ? to12h(s) : s;
  }

  formatCrosshairTime(t: number): string {
    const s = formatDateTime(t, this.tzOffset(t));
    return this.style.timeFormat === '12h' ? to12h(s) : s;
  }

  private render(): void {
    const ctx = this.ctx;
    const v = this.computeView();
    this.lastView = v;
    const p = this.palette;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.style.background2) {
      const g = ctx.createLinearGradient(0, 0, 0, this.height);
      g.addColorStop(0, p.chartBg);
      g.addColorStop(1, this.style.background2);
      ctx.fillStyle = g;
    } else ctx.fillStyle = p.chartBg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.textBaseline = 'middle';

    if (this.options.showGrid) this.drawGrid(v);
    // Each layer that reserves bottom height gets its own stacked sub-pane rect.
    const panes = new Map(this.panes().map((pr) => [pr.layer, pr]));
    for (const l of this.layers) {
      const pr = panes.get(l);
      if ((l.bottomHeight?.() ?? 0) > 0 && !pr) continue;
      const lv = pr ? { ...v, bottom: { x: v.bottom.x, y: pr.y, w: v.bottom.w, h: pr.h } } : v;
      ctx.save();
      l.draw(lv);
      ctx.restore();
    }
    this.drawAxes(v);
    this.drawExternalCrosshair(v);
    this.drawCrosshair(v);
    if (this.zoomBox) {
      const z = this.zoomBox;
      ctx.strokeStyle = p.textSecondary;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(z.x0, z.x1) + 0.5,
        Math.min(z.y0, z.y1) + 0.5,
        Math.abs(z.x1 - z.x0),
        Math.abs(z.y1 - z.y0),
      );
      ctx.setLineDash([]);
    }
    if (this.showDebug) this.drawDebug(v);
    for (const fn of this.priceListeners) fn(this.priceMin, this.priceMax);
    // Lazy history: tell listeners when the left edge is past the first slot.
    if (v.slotCount > 0 && this.pastStartListeners.size) {
      const n = v.slotCount;
      const leftV = this.vpos(n - 1, n) - v.plot.w / v.slotWidth + this.rightOffset + 0.5;
      const past = this.vpos(0, n) - leftV;
      if (past > 0) for (const fn of this.pastStartListeners) fn(past);
    }
  }

  private gridStroke(v: ChartView): void {
    const s = this.style.grid.line;
    v.ctx.strokeStyle = pick(s.color, v.palette.grid);
    v.ctx.lineWidth = s.width;
    v.ctx.setLineDash(dashFor(s.style, s.width));
  }

  private priceLevels(v: ChartView): number[] {
    return scaleLevels(v.priceMin, v.priceMax, v.plot.h, this.options.scaleMode, 56);
  }

  private drawGrid(v: ChartView): void {
    const ctx = v.ctx;
    const gs = this.style.grid;
    if (!gs.h && !gs.v) return;
    this.gridStroke(v);
    ctx.beginPath();
    if (gs.h) {
      for (const px of this.priceLevels(v)) {
        const y = Math.round(v.yOf(px)) + 0.5;
        ctx.moveTo(v.plot.x, y);
        ctx.lineTo(v.plot.x + v.plot.w, y);
      }
    }
    if (gs.v && gs.barStep > 0) {
      const st = Math.max(1, Math.round(gs.barStep));
      for (let i = Math.ceil(v.i0 / st) * st; i <= v.i1; i += st) {
        const x = Math.round(v.xOf(i) - v.slotWidth / 2) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, v.plot.h);
      }
    } else if (gs.v) {
      for (const x of this.timeGridXs(v)) {
        ctx.moveTo(Math.round(x.x) + 0.5, 0);
        ctx.lineTo(Math.round(x.x) + 0.5, v.plot.h);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  private timeGridXs(v: ChartView): { x: number; t: number; step: number }[] {
    const out: { x: number; t: number; step: number }[] = [];
    const src = this.source;
    if (v.i1 <= v.i0) return out;
    const t0 = src.timeAt(v.i0);
    const t1 = src.timeAt(v.i1);
    const span = Math.max(1, v.xOf(v.i1) - v.xOf(v.i0));
    const msPerPx = Math.max(1, (t1 - t0) / span);
    const step = niceTimeStep(msPerPx, 90);
    const off = this.tzOffset(t0) * 60_000;
    let prevBucket = Math.floor((src.timeAt(Math.max(0, v.i0 - 1)) + off) / step);
    let lastX = -Infinity;
    for (let i = v.i0; i <= v.i1; i++) {
      const t = src.timeAt(i);
      const b = Math.floor((t + off) / step);
      if (b !== prevBucket) {
        const x = v.xOf(i) - v.slotWidth / 2;
        if (x - lastX > 60 && x >= v.plot.x) {
          out.push({ x, t: b * step - off, step });
          lastX = x;
        }
        prevBucket = b;
      }
    }
    return out;
  }

  private drawPriceAxis(v: ChartView, a: Rect, side: 'left' | 'right'): void {
    const ctx = v.ctx;
    const p = v.palette;
    const ax = this.style.axis;
    ctx.fillStyle = pick(ax.bg, p.chartBg);
    ctx.fillRect(a.x, a.y, a.w, a.h);
    if (ax.border) {
      ctx.strokeStyle = p.divider;
      ctx.beginPath();
      const bx = side === 'right' ? a.x + 0.5 : a.x + a.w - 0.5;
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, a.h);
      ctx.stroke();
    }
    ctx.fillStyle = pick(ax.text, p.textSecondary);
    ctx.textAlign = 'left';
    ctx.font = v.font(ax.fontSize);
    const base = v.baseValue ?? 0;
    for (const px of this.priceLevels(v)) {
      const y = v.yOf(px);
      if (y < 8 || y > a.h - 8) continue;
      ctx.fillText(
        scaleLabel(px, this.options.scaleMode, base, (x) => formatPrice(x, v.instrument)),
        a.x + 8,
        y,
      );
    }
  }

  private drawAxes(v: ChartView): void {
    const ctx = v.ctx;
    const p = v.palette;
    const ax = this.style.axis;
    ctx.font = v.font(ax.fontSize);
    const aw = this.axisWidths();
    if (aw.right > 0) {
      const a = { x: v.right.x + v.right.w, y: 0, w: aw.right, h: v.plot.h };
      this.drawPriceAxis(v, a, 'right');
    }
    if (aw.left > 0) this.drawPriceAxis(v, { x: 0, y: 0, w: aw.left, h: v.plot.h }, 'left');
    if (this.options.priceAxis) for (const tag of v.tags) this.drawTag(v, tag);
    if (this.options.timeAxis) {
      const a = v.timeAxis;
      ctx.fillStyle = pick(ax.bg, p.chartBg);
      ctx.fillRect(0, a.y, this.width, a.h);
      if (ax.border) {
        ctx.strokeStyle = p.divider;
        ctx.beginPath();
        ctx.moveTo(0, a.y + 0.5);
        ctx.lineTo(this.width, a.y + 0.5);
        ctx.stroke();
      }
      ctx.fillStyle = pick(ax.text, p.textSecondary);
      ctx.font = v.font(ax.fontSize);
      ctx.textAlign = 'center';
      for (const g of this.timeGridXs(v))
        ctx.fillText(this.formatAxisTime(g.t, g.step), g.x, a.y + a.h / 2);
    }
  }

  private drawTag(v: ChartView, tag: PriceTag): void {
    const y = v.yOf(tag.px);
    if (y < -10 || y > v.plot.h + 10) return;
    const a = v.priceAxis;
    const ctx = v.ctx;
    const h = tag.sub ? 32 : 18;
    ctx.fillStyle = tag.bg;
    ctx.fillRect(a.x + 1, Math.round(y - 9), a.w - 1, h);
    ctx.fillStyle = tag.fg;
    ctx.font = v.font(11, 600);
    ctx.textAlign = 'left';
    ctx.fillText(tag.text ?? formatPrice(tag.px, v.instrument), a.x + 6, y);
    if (tag.sub) {
      ctx.font = v.font(10, 500);
      ctx.fillText(tag.sub, a.x + 6, y + 14);
    }
  }

  private crosshairStroke(v: ChartView): void {
    const s = this.style.crosshair.line;
    v.ctx.strokeStyle = pick(s.color, v.palette.textTertiary);
    v.ctx.lineWidth = s.width;
    v.ctx.setLineDash(dashFor(s.style, s.width));
  }

  private drawExternalCrosshair(v: ChartView): void {
    const c = this.externalCrosshair;
    if (!c || this.crosshair || v.slotCount === 0) return;
    const slot = slotAtOrBefore(this.source.timeAt, v.slotCount, c.t);
    if (slot < 0) return;
    const ctx = v.ctx;
    this.crosshairStroke(v);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    const x = Math.round(v.xOf(slot)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, v.timeAxis.y);
    if (this.externalShowsPrice) {
      const y = Math.round(v.yOf(c.px)) + 0.5;
      if (y > 0 && y < v.plot.h) {
        ctx.moveTo(v.plot.x, y);
        ctx.lineTo(v.plot.x + v.plot.w, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  private drawCrosshair(v: ChartView): void {
    const c = v.crosshair;
    if (!c || this.mouseMode === 'pointer') return;
    const ctx = v.ctx;
    const p = v.palette;
    const cs = this.style.crosshair;
    this.crosshairStroke(v);
    ctx.beginPath();
    const x = Math.round(v.xOf(c.slot)) + 0.5;
    const y = Math.round(c.y) + 0.5;
    if (c.y < v.plot.h) {
      ctx.moveTo(0, y);
      ctx.lineTo(v.priceAxis.x, y);
    }
    ctx.moveTo(x, 0);
    ctx.lineTo(x, v.timeAxis.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    const bg = pick(cs.labelBg, p.surface3);
    const fg = pick(cs.labelText, p.textPrimary);
    if (this.options.priceAxis && c.y < v.plot.h) {
      const a = v.priceAxis;
      ctx.fillStyle = bg;
      ctx.fillRect(a.x + 1, y - 9, a.w - 1, 18);
      ctx.fillStyle = fg;
      ctx.font = v.font(11, 500);
      ctx.textAlign = 'left';
      const raw = v.pxAt(c.y);
      const px = this.options.scaleMode === 'log' ? Math.round(raw) : raw - (raw % 1);
      ctx.fillText(
        scaleLabel(px, this.options.scaleMode, v.baseValue ?? 0, (q) =>
          formatPrice(q, v.instrument),
        ),
        a.x + 6,
        y,
      );
    }
    if (this.options.timeAxis && c.slot >= 0 && c.slot < v.slotCount) {
      const label = this.formatCrosshairTime(this.source.timeAt(c.slot));
      ctx.font = v.font(11, 500);
      const w = ctx.measureText(label).width + 12;
      const a = v.timeAxis;
      ctx.fillStyle = bg;
      ctx.fillRect(x - w / 2, a.y + 2, w, a.h - 4);
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.fillText(label, x, a.y + a.h / 2);
    }
  }

  private drawDebug(v: ChartView): void {
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    const ctx = v.ctx;
    ctx.font = v.font(10, 400, true);
    ctx.fillStyle = v.palette.warning;
    ctx.textAlign = 'right';
    ctx.fillText(
      `render ${avg.toFixed(2)} ms · slots ${v.i1 - v.i0 + 1}/${v.slotCount}`,
      v.plot.x + v.plot.w - 6,
      v.plot.h - 10,
    );
  }

  // ---------------------------------------------------------------- input

  private local(e: MouseEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hit(x: number, y: number): 'plot' | 'price-axis' | 'time-axis' | 'other' {
    const v = this.lastView;
    if (!v) return 'other';
    const aw = this.axisWidths();
    if (aw.right > 0 && x >= v.right.x + v.right.w && y < v.plot.h) return 'price-axis';
    if (aw.left > 0 && x < aw.left && y < v.plot.h) return 'price-axis';
    if (this.options.timeAxis && y >= v.timeAxis.y) return 'time-axis';
    if (y < v.plot.h && x >= v.plot.x && x < v.plot.x + v.plot.w) return 'plot';
    return 'other';
  }

  private emitCrosshair(): void {
    if (!this.crosshairListeners.size) return;
    const v = this.lastView;
    const c = this.crosshair;
    let pt: CrosshairPoint | null = null;
    if (v && c) {
      const n = this.source.count();
      const slot = v.slotAt(c.x);
      if (slot >= 0 && slot < n)
        pt = { t: this.source.timeAt(slot), px: Math.round(v.pxAt(c.y)), slot };
    }
    for (const fn of this.crosshairListeners) fn(pt);
  }

  private bindEvents(): void {
    const c = this.canvas;
    const opt = { signal: this.abort.signal } as AddEventListenerOptions;
    c.addEventListener('wheel', (e) => this.onWheel(e), { ...opt, passive: false });
    c.addEventListener(
      'keydown',
      (e) => {
        for (const h of this.pointerHandlers) {
          if (h.onKey?.(e)) {
            e.preventDefault();
            e.stopPropagation();
            this.invalidate();
            return;
          }
        }
      },
      opt,
    );
    c.addEventListener('mousedown', (e) => this.onDown(e), opt);
    window.addEventListener('mousemove', (e) => this.onMove(e), opt);
    window.addEventListener('mouseup', (e) => this.onUp(e), opt);
    c.addEventListener(
      'mouseleave',
      () => {
        if (!this.drag) {
          this.crosshair = null;
          this.emitCrosshair();
          this.invalidate();
        }
      },
      opt,
    );
    c.addEventListener(
      'dblclick',
      (e) => {
        const { x, y } = this.local(e);
        if (this.separatorAt(y)) {
          this.resetPanes();
          for (const fn of this.paneListeners) fn('*', 0);
          return;
        }
        const h = this.hit(x, y);
        if (h === 'price-axis') this.autoScale = true;
        else if (h === 'time-axis') this.reset();
        this.invalidate();
      },
      opt,
    );
    c.addEventListener(
      'click',
      (e) => {
        const v = this.lastView;
        if (!v) return;
        const { x, y } = this.local(e);
        for (let i = this.layers.length - 1; i >= 0; i--)
          if (this.layers[i]!.onClick?.(v, x, y, e)) break;
      },
      opt,
    );
  }

  private zoomPrice(anchorY: number, factor: number): void {
    const v = this.lastView;
    if (!v || this.linkedPrice) return;
    this.autoScale = false;
    const anchor = v.pxAt(Math.min(anchorY, v.plot.h));
    this.priceMin = anchor - (anchor - this.priceMin) / factor;
    this.priceMax = anchor + (this.priceMax - anchor) / factor;
  }

  private zoomTime(x: number, factor: number): void {
    const v = this.lastView;
    if (!v) return;
    const n = this.source.count();
    const lastV = this.vpos(n - 1, n);
    const right = v.plot.x + v.plot.w;
    // Virtual slot under the cursor stays fixed.
    const slotF = lastV - (right - (this.rightOffset + 0.5) * this.slotWidth - x) / this.slotWidth;
    const sw = Math.min(
      this.options.maxSlotWidth,
      Math.max(this.options.minSlotWidth, this.slotWidth * factor),
    );
    this.rightOffset = (right - x) / sw - 0.5 - (lastV - slotF);
    this.slotWidth = sw;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    const v = this.lastView;
    if (!v) return;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const w = this.options.wheel;
    if (e.ctrlKey || this.hit(x, y) === 'price-axis') {
      // Ctrl + wheel = zoom price around the cursor.
      this.zoomPrice(y, factor);
    } else if (e.shiftKey || w === 'scroll') {
      this.rightOffset -= (e.deltaY || e.deltaX) / this.slotWidth / 2;
    } else {
      // Wheel = zoom time, keeping the slot under the cursor fixed.
      this.zoomTime(x, factor);
      if (w === 'zoom-xy') this.zoomPrice(y, factor);
    }
    this.invalidate();
  }

  private onDown(e: MouseEvent): void {
    const { x, y } = this.local(e);
    const h = this.hit(x, y);
    if (e.button !== 0 && e.button !== 1) return;
    this.canvas.focus();
    const view = this.lastView;
    const base = {
      x,
      y,
      slotWidth: this.slotWidth,
      rightOffset: this.rightOffset,
      pmin: this.priceMin,
      pmax: this.priceMax,
      shift: e.shiftKey,
    };
    // Pane separators win over everything (drag to resize).
    const sep = e.button === 0 ? this.separatorAt(y) : null;
    if (sep) {
      const layer = this.layers.find((l) => l.id === sep);
      const pr = this.panes().find((p) => p.layer.id === sep);
      if (layer && pr) {
        this.drag = { kind: 'separator', ...base, layerId: sep, h0: pr.h };
        e.preventDefault();
        return;
      }
    }
    if (view && e.button === 0) {
      for (const ph of this.pointerHandlers) {
        if (ph.onDown?.(view, x, y, e)) {
          this.captured = ph;
          e.preventDefault();
          this.invalidate();
          return;
        }
      }
    }
    if (h === 'price-axis') this.drag = { kind: 'price-axis', ...base };
    else if (h === 'time-axis') this.drag = { kind: 'time-axis', ...base };
    else if (h === 'plot' && e.button === 0 && this.mouseMode === 'zoom') {
      this.drag = { kind: 'zoom-box', ...base };
      this.zoomBox = { x0: x, y0: y, x1: x, y1: y };
    } else if (h === 'plot') this.drag = { kind: 'pan', ...base };
    if (this.drag) e.preventDefault();
  }

  private onMove(e: MouseEvent): void {
    const { x, y } = this.local(e);
    const d = this.drag;
    const v = this.lastView;
    if (v) {
      if (this.captured) {
        this.captured.onMove?.(v, x, y, e, true);
        this.crosshair = { x, y };
        this.invalidate();
        return;
      }
      if (x >= 0 && y >= 0 && x <= this.width && y <= this.height) {
        let cursor: string | null = null;
        for (const ph of this.pointerHandlers) {
          ph.onMove?.(v, x, y, e, false);
          cursor = cursor ?? ph.cursor?.(v, x, y) ?? null;
        }
        if (!cursor && (d?.kind === 'separator' || (!d && this.separatorAt(y))))
          cursor = 'row-resize';
        this.canvas.style.cursor =
          cursor ?? (this.mouseMode === 'crosshair' ? 'crosshair' : 'default');
      }
    }
    if (d && v) {
      const dx = x - d.x;
      const dy = y - d.y;
      const sign = this.options.invertScale ? -1 : 1;
      if (d.kind === 'separator' && d.layerId) {
        const ta = this.options.timeAxis ? this.options.timeAxisHeight : 0;
        const others = this.panes()
          .filter((p) => p.layer.id !== d.layerId)
          .reduce((s, p) => s + p.h, 0);
        const maxH = this.height - ta - others - this.options.minMainHeight;
        const h = Math.round(Math.max(24, Math.min(maxH, (d.h0 ?? 0) - dy)));
        const layer = this.layers.find((l) => l.id === d.layerId);
        if (layer?.setBottomHeight) layer.setBottomHeight(h);
        else this.paneHeights.set(d.layerId, h);
        this.maximizedPane = null;
        for (const fn of this.paneListeners) fn(d.layerId, h);
      } else if (d.kind === 'pan') {
        if (!d.shift) this.rightOffset = d.rightOffset + dx / this.slotWidth;
        if ((!this.autoScale || d.shift || this.mouseMode === 'zoomxy') && !this.linkedPrice) {
          this.autoScale = false;
          const shift = (sign * dy) / v.tickPx;
          this.priceMin = d.pmin + shift;
          this.priceMax = d.pmax + shift;
        }
      } else if (d.kind === 'price-axis' && !this.linkedPrice) {
        this.autoScale = false;
        const f = Math.exp(dy * 0.005);
        const mid = (d.pmin + d.pmax) / 2;
        const half = ((d.pmax - d.pmin) / 2) * f;
        this.priceMin = mid - half;
        this.priceMax = mid + half;
      } else if (d.kind === 'time-axis') {
        this.slotWidth = Math.min(
          this.options.maxSlotWidth,
          Math.max(this.options.minSlotWidth, d.slotWidth * Math.exp(-dx * 0.01)),
        );
      } else if (d.kind === 'zoom-box' && this.zoomBox) {
        this.zoomBox.x1 = x;
        this.zoomBox.y1 = y;
      }
      this.invalidate();
    }
    const inside = x >= 0 && y >= 0 && x <= this.width && y <= this.height;
    if (inside || d) {
      this.crosshair = { x, y };
      this.emitCrosshair();
      this.invalidate();
    }
  }

  private onUp(e: MouseEvent): void {
    if (this.captured) {
      const v = this.lastView;
      const { x, y } = this.local(e);
      if (v) this.captured.onUp?.(v, x, y, e);
      this.captured = null;
      this.invalidate();
      return;
    }
    if (this.drag?.kind === 'zoom-box' && this.zoomBox && this.lastView) {
      const v = this.lastView;
      const z = this.zoomBox;
      if (Math.abs(z.x1 - z.x0) > 8 && Math.abs(z.y1 - z.y0) > 8) {
        const n = this.source.count();
        const s0 = this.vpos(v.slotAt(Math.min(z.x0, z.x1)), n);
        const s1 = this.vpos(v.slotAt(Math.max(z.x0, z.x1)), n);
        this.slotWidth = Math.min(this.options.maxSlotWidth, v.plot.w / Math.max(1, s1 - s0 + 1));
        this.rightOffset = this.vpos(n - 1, n) - s1;
        this.autoScale = false;
        const a = v.pxAt(Math.min(z.y0, z.y1));
        const b = v.pxAt(Math.max(z.y0, z.y1));
        this.priceMax = Math.max(a, b);
        this.priceMin = Math.min(a, b);
      }
      this.zoomBox = null;
    }
    this.drag = null;
    this.invalidate();
  }
}

/** "13:05" → "1:05 PM" inside a label (keeps the rest of the text). */
function to12h(s: string): string {
  return s.replace(/\b(\d{2}):(\d{2})(:\d{2})?\b/, (_m, h: string, m: string, sec?: string) => {
    const hh = Number(h);
    const ap = hh >= 12 ? 'PM' : 'AM';
    return `${hh % 12 || 12}:${m}${sec ?? ''} ${ap}`;
  });
}
