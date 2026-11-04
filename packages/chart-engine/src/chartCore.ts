import { formatPrice, type Instrument } from '@htflow/market-data';
import { formatDateTime, formatTime, nicePriceStep, niceTimeStep } from './scale';
import type { ChartLayer, ChartPalette, ChartView, PriceTag, Rect, SlotSource } from './types';

export type MouseMode = 'pointer' | 'crosshair' | 'zoom' | 'scroll' | 'zoomxy';

export interface ChartCoreOptions {
  priceAxis: boolean;
  timeAxis: boolean;
  priceAxisWidth: number;
  timeAxisHeight: number;
  /** Empty slots kept to the right of the last slot when following live data. */
  rightMargin: number;
  minSlotWidth: number;
  maxSlotWidth: number;
  showGrid: boolean;
  autoScalePadding: number;
  fontFamily: string;
  monoFamily: string;
}

const DEFAULTS: ChartCoreOptions = {
  priceAxis: true,
  timeAxis: true,
  priceAxisWidth: 64,
  timeAxisHeight: 22,
  rightMargin: 4,
  minSlotWidth: 1,
  maxSlotWidth: 400,
  showGrid: true,
  autoScalePadding: 0.08,
  fontFamily: '"Geist", "Segoe UI", system-ui, sans-serif',
  monoFamily: '"Geist Mono", Consolas, monospace',
};

export interface PriceRangeListener {
  (min: number, max: number): void;
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
  instrument: Instrument;
  source: SlotSource = { count: () => 0, timeAt: () => 0 };

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

  private width = 0;
  private height = 0;
  private dpr = 1;
  private dirty = true;
  private raf = 0;
  private crosshair: { x: number; y: number } | null = null;
  private drag: null | {
    kind: 'pan' | 'price-axis' | 'time-axis' | 'zoom-box';
    x: number;
    y: number;
    slotWidth: number;
    rightOffset: number;
    pmin: number;
    pmax: number;
    shift: boolean;
  } = null;
  private zoomBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private ro: ResizeObserver | null = null;
  private lastView: ChartView | null = null;
  private frameTimes: number[] = [];
  private priceListeners = new Set<PriceRangeListener>();
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
    this.invalidate();
  }

  onPriceRange(fn: PriceRangeListener): () => void {
    this.priceListeners.add(fn);
    return () => this.priceListeners.delete(fn);
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
    this.rightOffset = n - 1 - i - visible / 2;
    this.invalidate();
  }

  get view(): ChartView | null {
    return this.lastView;
  }

  /** Renders a PNG of the current frame (snapshot camera). */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
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

  private gutters(): { left: number; right: number; bottom: number } {
    let left = 0;
    let right = 0;
    let bottom = 0;
    for (const l of this.layers) {
      left += l.leftGutter?.() ?? 0;
      right += l.rightGutter?.() ?? 0;
      bottom += l.bottomHeight?.() ?? 0;
    }
    return { left, right, bottom };
  }

  private plotRect(): Rect {
    const g = this.gutters();
    const pa = this.options.priceAxis ? this.options.priceAxisWidth : 0;
    const ta = this.options.timeAxis ? this.options.timeAxisHeight : 0;
    return {
      x: g.left,
      y: 0,
      w: Math.max(10, this.width - g.left - g.right - pa),
      h: Math.max(10, this.height - ta - g.bottom),
    };
  }

  // ---------------------------------------------------------------- frame

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty || this.width < 2) return;
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
    const plot = this.plotRect();
    const n = this.source.count();
    const sw = this.slotWidth;
    // x of slot centre: last slot sits rightOffset slots from the right edge.
    const lastX = plot.x + plot.w - (this.rightOffset + 0.5) * sw;
    const xOf = (i: number) => lastX - (n - 1 - i) * sw;
    const slotAt = (x: number) => Math.round(n - 1 - (lastX - x) / sw);
    const i0 = Math.max(0, Math.floor(slotAt(plot.x)) - 1);
    const i1 = Math.min(n - 1, Math.ceil(slotAt(plot.x + plot.w)) + 1);

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
        const pad = (hi - lo) * o.autoScalePadding;
        this.priceMin = lo - pad;
        this.priceMax = hi + pad;
      }
    }
    const pmin = this.priceMin;
    const pmax = this.priceMax;
    const tickPx = plot.h / Math.max(1e-9, pmax - pmin);
    const yOf = (px: number) => plot.y + (pmax - px) * tickPx;
    const pxAt = (y: number) => pmax - (y - plot.y) / tickPx;
    const pa = o.priceAxis ? o.priceAxisWidth : 0;
    const ta = o.timeAxis ? o.timeAxisHeight : 0;
    const right: Rect = { x: plot.x + plot.w, y: 0, w: g.right, h: plot.h };
    const ch = this.crosshair;
    const font = (size: number, weight = 400, mono = false) =>
      `${weight} ${size}px ${mono ? o.monoFamily : o.fontFamily}`;
    return {
      ctx: this.ctx,
      palette: this.palette,
      instrument: this.instrument,
      width: this.width,
      height: this.height,
      plot,
      left: { x: 0, y: 0, w: g.left, h: plot.h },
      right,
      bottom: { x: plot.x, y: plot.h, w: plot.w, h: g.bottom },
      priceAxis: { x: right.x + right.w, y: 0, w: pa, h: plot.h },
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
      yOf,
      pxAt,
      crosshair: ch ? { x: ch.x, y: ch.y, slot: slotAt(ch.x), px: Math.round(pxAt(ch.y)) } : null,
      tags: [],
      font,
    };
  }

  private render(): void {
    const ctx = this.ctx;
    const v = this.computeView();
    this.lastView = v;
    const p = this.palette;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.textBaseline = 'middle';

    if (this.options.showGrid) this.drawGrid(v);
    for (const l of this.layers) {
      ctx.save();
      l.draw(v);
      ctx.restore();
    }
    this.drawAxes(v);
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
  }

  private drawGrid(v: ChartView): void {
    const ctx = v.ctx;
    ctx.strokeStyle = v.palette.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    const step = nicePriceStep(v.tickPx, 56);
    const first = Math.ceil(v.priceMin / step) * step;
    for (let px = first; px <= v.priceMax; px += step) {
      const y = Math.round(v.yOf(px)) + 0.5;
      ctx.moveTo(v.plot.x, y);
      ctx.lineTo(v.plot.x + v.plot.w, y);
    }
    for (const x of this.timeGridXs(v)) {
      ctx.moveTo(Math.round(x.x) + 0.5, 0);
      ctx.lineTo(Math.round(x.x) + 0.5, v.plot.h);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private timeGridXs(v: ChartView): { x: number; t: number; step: number }[] {
    const out: { x: number; t: number; step: number }[] = [];
    const src = this.source;
    if (v.i1 <= v.i0) return out;
    const t0 = src.timeAt(v.i0);
    const t1 = src.timeAt(v.i1);
    const msPerPx = Math.max(1, (t1 - t0) / Math.max(1, (v.i1 - v.i0) * v.slotWidth));
    const step = niceTimeStep(msPerPx, 90);
    let prevBucket = Math.floor(src.timeAt(Math.max(0, v.i0 - 1)) / step);
    let lastX = -Infinity;
    for (let i = v.i0; i <= v.i1; i++) {
      const t = src.timeAt(i);
      const b = Math.floor(t / step);
      if (b !== prevBucket) {
        const x = v.xOf(i) - v.slotWidth / 2;
        if (x - lastX > 60 && x >= v.plot.x) {
          out.push({ x, t: b * step, step });
          lastX = x;
        }
        prevBucket = b;
      }
    }
    return out;
  }

  private drawAxes(v: ChartView): void {
    const ctx = v.ctx;
    const p = v.palette;
    ctx.font = v.font(11);
    if (this.options.priceAxis) {
      const a = v.priceAxis;
      ctx.fillStyle = p.chartBg;
      ctx.fillRect(a.x, a.y, a.w, a.h + (this.options.timeAxis ? 0 : 0));
      ctx.strokeStyle = p.divider;
      ctx.beginPath();
      ctx.moveTo(a.x + 0.5, 0);
      ctx.lineTo(a.x + 0.5, a.h);
      ctx.stroke();
      ctx.fillStyle = p.textSecondary;
      ctx.textAlign = 'left';
      const step = nicePriceStep(v.tickPx, 56);
      const first = Math.ceil(v.priceMin / step) * step;
      for (let px = first; px <= v.priceMax; px += step) {
        const y = v.yOf(px);
        if (y < 8 || y > a.h - 8) continue;
        ctx.fillText(formatPrice(px, v.instrument), a.x + 8, y);
      }
      for (const tag of v.tags) this.drawTag(v, tag);
    }
    if (this.options.timeAxis) {
      const a = v.timeAxis;
      ctx.fillStyle = p.chartBg;
      ctx.fillRect(0, a.y, this.width, a.h);
      ctx.strokeStyle = p.divider;
      ctx.beginPath();
      ctx.moveTo(0, a.y + 0.5);
      ctx.lineTo(this.width, a.y + 0.5);
      ctx.stroke();
      ctx.fillStyle = p.textSecondary;
      ctx.textAlign = 'center';
      for (const g of this.timeGridXs(v)) ctx.fillText(formatTime(g.t, g.step), g.x, a.y + a.h / 2);
    }
  }

  private drawTag(v: ChartView, tag: PriceTag): void {
    const y = v.yOf(tag.px);
    if (y < -10 || y > v.plot.h + 10) return;
    const a = v.priceAxis;
    const ctx = v.ctx;
    ctx.fillStyle = tag.bg;
    ctx.fillRect(a.x + 1, Math.round(y - 9), a.w - 1, 18);
    ctx.fillStyle = tag.fg;
    ctx.font = v.font(11, 600);
    ctx.textAlign = 'left';
    ctx.fillText(tag.text ?? formatPrice(tag.px, v.instrument), a.x + 6, y);
  }

  private drawCrosshair(v: ChartView): void {
    const c = v.crosshair;
    if (!c || this.mouseMode === 'pointer') return;
    const ctx = v.ctx;
    const p = v.palette;
    ctx.strokeStyle = p.textTertiary;
    ctx.setLineDash([3, 3]);
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
    if (this.options.priceAxis && c.y < v.plot.h) {
      const a = v.priceAxis;
      ctx.fillStyle = p.surface3;
      ctx.fillRect(a.x + 1, y - 9, a.w - 1, 18);
      ctx.fillStyle = p.textPrimary;
      ctx.font = v.font(11, 500);
      ctx.textAlign = 'left';
      ctx.fillText(formatPrice(v.pxAt(c.y) - (v.pxAt(c.y) % 1), v.instrument), a.x + 6, y);
    }
    if (this.options.timeAxis && c.slot >= 0 && c.slot < v.slotCount) {
      const label = formatDateTime(this.source.timeAt(c.slot));
      ctx.font = v.font(11, 500);
      const w = ctx.measureText(label).width + 12;
      const a = v.timeAxis;
      ctx.fillStyle = p.surface3;
      ctx.fillRect(x - w / 2, a.y + 2, w, a.h - 4);
      ctx.fillStyle = p.textPrimary;
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
    if (this.options.priceAxis && x >= v.priceAxis.x && y < v.plot.h) return 'price-axis';
    if (this.options.timeAxis && y >= v.timeAxis.y) return 'time-axis';
    if (y < v.plot.h && x >= v.plot.x && x < v.plot.x + v.plot.w) return 'plot';
    return 'other';
  }

  private bindEvents(): void {
    const c = this.canvas;
    const opt = { signal: this.abort.signal } as AddEventListenerOptions;
    c.addEventListener('wheel', (e) => this.onWheel(e), { ...opt, passive: false });
    c.addEventListener('mousedown', (e) => this.onDown(e), opt);
    window.addEventListener('mousemove', (e) => this.onMove(e), opt);
    window.addEventListener('mouseup', (e) => this.onUp(e), opt);
    c.addEventListener(
      'mouseleave',
      () => {
        if (!this.drag) {
          this.crosshair = null;
          this.invalidate();
        }
      },
      opt,
    );
    c.addEventListener(
      'dblclick',
      (e) => {
        const { x, y } = this.local(e);
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

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x, y } = this.local(e);
    const v = this.lastView;
    if (!v) return;
    const factor = Math.exp(-e.deltaY * 0.0015);
    if (e.ctrlKey || this.hit(x, y) === 'price-axis') {
      // Ctrl + wheel = zoom price around the cursor.
      if (this.linkedPrice) return;
      this.autoScale = false;
      const anchor = v.pxAt(Math.min(y, v.plot.h));
      this.priceMin = anchor - (anchor - this.priceMin) / factor;
      this.priceMax = anchor + (this.priceMax - anchor) / factor;
    } else if (e.shiftKey) {
      this.rightOffset -= e.deltaY / this.slotWidth / 2;
    } else {
      // Wheel = zoom time, keeping the slot under the cursor fixed.
      const n = this.source.count();
      const slotF =
        n -
        1 -
        (v.plot.x + v.plot.w - (this.rightOffset + 0.5) * this.slotWidth - x) / this.slotWidth;
      const sw = Math.min(
        this.options.maxSlotWidth,
        Math.max(this.options.minSlotWidth, this.slotWidth * factor),
      );
      const right = v.plot.x + v.plot.w;
      this.rightOffset = (right - x) / sw - 0.5 - (n - 1 - slotF);
      this.slotWidth = sw;
    }
    this.invalidate();
  }

  private onDown(e: MouseEvent): void {
    const { x, y } = this.local(e);
    const h = this.hit(x, y);
    if (e.button !== 0 && e.button !== 1) return;
    this.canvas.focus();
    const base = {
      x,
      y,
      slotWidth: this.slotWidth,
      rightOffset: this.rightOffset,
      pmin: this.priceMin,
      pmax: this.priceMax,
      shift: e.shiftKey,
    };
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
    if (d && v) {
      const dx = x - d.x;
      const dy = y - d.y;
      if (d.kind === 'pan') {
        if (!d.shift) this.rightOffset = d.rightOffset + dx / this.slotWidth;
        if ((!this.autoScale || d.shift || this.mouseMode === 'zoomxy') && !this.linkedPrice) {
          this.autoScale = false;
          const shift = dy / v.tickPx;
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
      this.invalidate();
    }
  }

  private onUp(_e: MouseEvent): void {
    if (this.drag?.kind === 'zoom-box' && this.zoomBox && this.lastView) {
      const v = this.lastView;
      const z = this.zoomBox;
      if (Math.abs(z.x1 - z.x0) > 8 && Math.abs(z.y1 - z.y0) > 8) {
        const s0 = v.slotAt(Math.min(z.x0, z.x1));
        const s1 = v.slotAt(Math.max(z.x0, z.x1));
        this.slotWidth = Math.min(this.options.maxSlotWidth, v.plot.w / Math.max(1, s1 - s0 + 1));
        this.rightOffset = this.source.count() - 1 - s1;
        this.autoScale = false;
        this.priceMax = v.pxAt(Math.min(z.y0, z.y1));
        this.priceMin = v.pxAt(Math.max(z.y0, z.y1));
      }
      this.zoomBox = null;
    }
    this.drag = null;
    this.invalidate();
  }
}
