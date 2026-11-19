import {
  painterOf,
  type ChartLayer,
  type ChartView,
  type PixelImage,
  type SlotSource,
} from '@htflow/chart-engine';
import {
  formatCompact,
  formatPrice,
  type DepthColumn,
  type OrderBook,
  type Trade,
} from '@htflow/market-data';
import {
  aggregateBubbles,
  bubbleAt,
  bubbleRadius,
  slotOfTrades,
  slotVolumes,
  type Bubble,
  type BubbleCalc,
  type BubbleStyle,
  type PlacedBubble,
} from './bubbles';
import { TrackerSync, type IcebergEvent, type SpoofEvent } from './detectors';
import { lutFromStops, presetStops, rgba, type HeatScale, type HeatStop } from './gradient';
import {
  globalCutoffs,
  SessionCutoffs,
  type Cutoffs,
  type NormalizeMode,
  type NormalizeScope,
} from './normalize';
import { HeatBuffer, lifetimeLut, lut32Of, type LargeRun } from './pixelBuffer';

export interface HeatmapSettings {
  // ---- Heatmap section
  /** Draw the depth heat texture. */
  heat: boolean;
  /** Preset id (see GRADIENTS) or 'custom' for `customStops`. */
  gradient: string;
  customStops: HeatStop[];
  /** 0..100 */
  brightness: number;
  /** 0..100, 50 = neutral. */
  contrast: number;
  /** 0.2..5, 1 = neutral. */
  gamma: number;
  /** 10..100 */
  opacity: number;
  /** Upper cut-off percentile (default 98). */
  cutoffUpper: number;
  /** Lower cut-off percentile (default 20). */
  cutoffLower: number;
  scale: HeatScale;
  normalize: NormalizeMode;
  /** Where global cut-offs come from. */
  scope: NormalizeScope;
  /** Resting sizes below this are not drawn. */
  minSize: number;
  /** Smooth the scaled texture instead of hard pixel steps. */
  smoothing: boolean;
  // ---- Bubbles section
  bubbles: boolean;
  /** Hide trade bubbles smaller than this. */
  minLots: number;
  /** Size 1..100 */
  bubbleScale: number;
  /** Clustering 0..10 (ticks and × 100 ms). */
  clustering: number;
  bubbleCalc: BubbleCalc;
  bubbleStyle: BubbleStyle;
  /** 10..100 */
  bubbleOpacity: number;
  /** '' = theme colour. */
  buyColor: string;
  sellColor: string;
  plainColor: string;
  // ---- Best bid / ask section
  bestBidAsk: boolean;
  /** Separate bid / ask lines, or one stepped mid line. */
  bbaMode: 'bid-ask' | 'mid';
  bidColor: string;
  askColor: string;
  bbaWidth: number;
  /** Dashed extension into the future. */
  bbaExtend: boolean;
  // ---- Depth of market section
  domColumn: boolean;
  domWidth: number;
  domLabels: boolean;
  // ---- Volume section
  volume: boolean;
  volumeCalc: BubbleCalc;
  volumeLabels: boolean;
  volumeHeight: number;
  // ---- Full settings
  largeOrders: boolean;
  largeOrderSize: number;
  largeOrderColor: string;
  lifetime: boolean;
  lifetimeYoung: string;
  lifetimeOld: string;
  lifetimeMaxSec: number;
  icebergs: boolean;
  icebergRatio: number;
  icebergColor: string;
  spoofs: boolean;
  /** 0 = auto (4 × column mean). */
  spoofMinSize: number;
  spoofMaxLifeSec: number;
  spoofColor: string;
  /** Minutes of depth history shown (0 = everything recorded). */
  historyMinutes: number;
  /** Size at the crosshair level next to the cursor. */
  crosshairReadout: boolean;
  /** Ticks shown above / below the touch when auto-scaling (0 = 60 % of the visible spread). */
  rangeLevels: number;
  /** Book levels per side drawn (0 = all). */
  levelsLimit: number;
  /** Traded-volume profile of the visible range behind the DOM column. */
  volumeProfile: boolean;
}

export const DEFAULT_HEATMAP: HeatmapSettings = {
  heat: true,
  gradient: 'ruby',
  customStops: presetStops('thermal'),
  brightness: 100,
  contrast: 50,
  gamma: 1,
  opacity: 100,
  cutoffUpper: 98,
  cutoffLower: 20,
  scale: 'sqrt',
  normalize: 'global',
  scope: 'visible',
  minSize: 0,
  smoothing: false,
  bubbles: true,
  minLots: 1,
  bubbleScale: 50,
  clustering: 0,
  bubbleCalc: 'volume',
  bubbleStyle: 'dominant',
  bubbleOpacity: 35,
  buyColor: '',
  sellColor: '',
  plainColor: '#D9D9D9',
  bestBidAsk: true,
  bbaMode: 'mid',
  bidColor: '',
  askColor: '',
  bbaWidth: 2,
  bbaExtend: false,
  domColumn: true,
  domWidth: 150,
  domLabels: true,
  volume: false,
  volumeCalc: 'volume',
  volumeLabels: false,
  volumeHeight: 70,
  largeOrders: false,
  largeOrderSize: 100,
  largeOrderColor: '#FFFFFF',
  lifetime: false,
  lifetimeYoung: '#4FA3F7',
  lifetimeOld: '#F5D547',
  lifetimeMaxSec: 120,
  icebergs: false,
  icebergRatio: 3,
  icebergColor: '#7FF0FF',
  spoofs: false,
  spoofMinSize: 0,
  spoofMaxLifeSec: 10,
  spoofColor: '#C77DFF',
  historyMinutes: 0,
  crosshairReadout: false,
  rangeLevels: 0,
  levelsLimit: 0,
  volumeProfile: false,
};

/** What is under the pointer (tooltip). */
export type HeatHit =
  | { kind: 'bubble'; bubble: Bubble; x: number; y: number }
  | {
      kind: 'cell';
      t: number;
      px: number;
      qty: number;
      side: 'bid' | 'ask' | null;
      x: number;
      y: number;
      spoof?: SpoofEvent;
      iceberg?: IcebergEvent;
    };

export interface HeatStats {
  /** Pixel buffer fill (ms). */
  heatMs: number;
  /** Whole layer draw (ms). */
  drawMs: number;
  cols: number;
  rows: number;
  cells: number;
}

/** Spoof flashes stay animated this long (data time, ms). */
const FLASH_MS = 4000;

/**
 * Liquidity map (P11 / P46 board 22): resting-depth history as a heat texture (one pixel per
 * column × price row, scaled up without smoothing), best bid / ask, trade bubbles, DOM column,
 * volume bars, large-order outlines, order-lifetime colours, iceberg markers and spoof flashes.
 */
export class LiquidityMapLayer implements ChartLayer {
  readonly id = 'liquidity-map';
  settings: HeatmapSettings;
  /** Base columns per slot (250 ms base → 1 s = 4, 5 s = 20). */
  stride = 1;
  /** Timing of the last frame (stress test overlay). */
  stats: HeatStats = { heatMs: 0, drawMs: 0, cols: 0, rows: 0, cells: 0 };
  /** True while spoof flashes are animating (host keeps invalidating). */
  animating = false;
  /** Bubbles placed in the last frame (hit testing). */
  placed: PlacedBubble[] = [];
  private lut: Uint8ClampedArray = new Uint8ClampedArray(1024);
  private lifeLut: Uint32Array | null = null;
  private lutKey = '';
  /** The pixel buffer as a painter image (texture on WebGL2, off-screen canvas on Canvas2D). */
  private img: PixelImage | null = null;
  private buf = new HeatBuffer();
  private session = new SessionCutoffs();
  private sync = new TrackerSync();
  private offKey = '';
  private offIdx = 0;
  private runs: LargeRun[] = [];
  private lastRowTicks = 1;

  constructor(
    private depth: () => DepthColumn[],
    private trades: (from: number, to: number) => Trade[],
    private book: () => OrderBook,
    settings: Partial<HeatmapSettings> = {},
  ) {
    this.settings = { ...DEFAULT_HEATMAP, ...settings };
  }

  // ---------------------------------------------------------------- data access

  /** Index of the first depth column inside the history window. */
  private historyStart(): number {
    const d = this.depth();
    const mins = this.settings.historyMinutes;
    if (!d.length || mins <= 0) return 0;
    const lastT = d[d.length - 1]!.t;
    const key = `${d.length}:${d[0]!.t}:${lastT}:${mins}`;
    if (key === this.offKey) return this.offIdx;
    const from = lastT - mins * 60_000;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid]!.t < from) lo = mid + 1;
      else hi = mid;
    }
    this.offKey = key;
    this.offIdx = lo;
    return lo;
  }

  /** Slots of the visible history (use as the chart's x source). */
  source(): SlotSource {
    return {
      count: () => {
        const n = this.depth().length - this.historyStart();
        return Math.max(0, Math.ceil(n / this.stride));
      },
      timeAt: (i) => this.col(i)?.t ?? 0,
    };
  }

  /** Column of a slot. */
  col(i: number): DepthColumn | undefined {
    const d = this.depth();
    if (!d.length || i < 0) return undefined;
    return d[Math.min(d.length - 1, this.historyStart() + i * this.stride)];
  }

  /** Slot of a time (last slot with column time ≤ t). */
  slotAtTime(t: number): number {
    const d = this.depth();
    const s0 = this.historyStart();
    let lo = s0;
    let hi = d.length - 1;
    if (hi < lo || t < d[lo]!.t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (d[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    return Math.floor((lo - s0) / this.stride);
  }

  get spoofEvents(): readonly SpoofEvent[] {
    return this.sync.tracker.spoofs;
  }

  get icebergEvents(): readonly IcebergEvent[] {
    return this.sync.tracker.icebergs;
  }

  // ---------------------------------------------------------------- layout

  rightGutter(): number {
    return this.settings.domColumn ? Math.max(60, this.settings.domWidth) : 0;
  }

  bottomHeight(): number {
    return this.settings.volume ? Math.max(24, this.settings.volumeHeight) : 0;
  }

  priceRange(i0: number, i1: number): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const c = this.col(i);
      if (!c) continue;
      if (c.bestBid < lo) lo = c.bestBid;
      if (c.bestAsk > hi) hi = c.bestAsk;
    }
    if (!Number.isFinite(lo)) return null;
    const L = this.settings.rangeLevels;
    if (L > 0) return [lo - L, hi + L];
    const span = Math.max(30, hi - lo);
    return [lo - span * 0.6, hi + span * 0.6];
  }

  /** Current colour table (RGBA bytes) — shared with the 3D view. */
  colorLut(): Uint8ClampedArray {
    this.ensureLut();
    return this.lut;
  }

  /** Cut-offs used in global mode for the given visible slots. */
  globalCut(i0: number, i1: number, priceRange: [number, number] | null): Cutoffs {
    const s = this.settings;
    const d = this.depth();
    if (s.scope === 'session') return this.session.get(d, s.cutoffLower, s.cutoffUpper);
    const a = this.historyStart() + Math.max(0, i0) * this.stride;
    const b = this.historyStart() + Math.max(0, i1) * this.stride;
    // Sample only the columns actually drawn (stride), not the whole span.
    if (this.stride === 1) return globalCutoffs(d, a, b, s.cutoffLower, s.cutoffUpper, priceRange);
    const cols: DepthColumn[] = [];
    for (let i = i0; i <= i1; i++) {
      const c = this.col(i);
      if (c) cols.push(c);
    }
    return globalCutoffs(cols, 0, cols.length - 1, s.cutoffLower, s.cutoffUpper, priceRange);
  }

  private ensureLut(): void {
    const s = this.settings;
    const stops = s.gradient === 'custom' ? s.customStops : presetStops(s.gradient);
    const key = `${JSON.stringify(stops)}:${s.brightness}:${s.contrast}:${s.gamma}:${s.opacity}:${s.lifetime ? s.lifetimeYoung + s.lifetimeOld : ''}`;
    if (key === this.lutKey) return;
    this.lut = lutFromStops(stops, {
      brightness: s.brightness,
      contrast: s.contrast,
      gamma: s.gamma,
      opacity: s.opacity,
    });
    this.lifeLut = s.lifetime ? lifetimeLut(this.lut, s.lifetimeYoung, s.lifetimeOld) : null;
    this.lutKey = key;
  }

  // ---------------------------------------------------------------- draw

  draw(v: ChartView): void {
    const t0 = performance.now();
    const s = this.settings;
    this.ensureLut();
    if (s.icebergs || s.spoofs) {
      const opts = this.sync.tracker.opts;
      opts.icebergRatio = s.icebergRatio;
      opts.spoofMinSize = s.spoofMinSize;
      opts.spoofMaxLifeMs = s.spoofMaxLifeSec * 1000;
      this.sync.sync(this.depth(), this.trades);
    }
    this.runs = [];
    this.drawHeat(v);
    if (s.largeOrders) this.drawLargeOrders(v);
    if (s.spoofs) this.drawSpoofs(v);
    else this.animating = false;
    if (s.icebergs) this.drawIcebergs(v);
    if (s.bestBidAsk) this.drawBestLine(v);
    let tradesCache: { list: Trade[]; slots: Int32Array } | null = null;
    const visibleTrades = () => (tradesCache ??= this.visibleTrades(v));
    if (s.bubbles) this.drawBubbles(v, visibleTrades());
    else this.placed = [];
    if (s.volume) this.drawVolume(v, visibleTrades());
    if (s.domColumn) this.drawDom(v, s.volumeProfile ? visibleTrades().list : null);
    if (s.crosshairReadout && v.crosshair) this.drawReadout(v);
    this.stats.drawMs = performance.now() - t0;
  }

  private visibleTrades(v: ChartView): { list: Trade[]; slots: Int32Array } {
    const c0 = this.col(v.i0);
    const c1 = this.col(v.i1);
    if (!c0 || !c1) return { list: [], slots: new Int32Array(0) };
    const span = this.stride * 250;
    const list = this.trades(c0.t, c1.t + span);
    const slots = slotOfTrades(list, (i) => this.col(i)?.t, v.i0, v.i1);
    return { list, slots };
  }

  private drawHeat(v: ChartView): void {
    const s = this.settings;
    const cols = v.i1 - v.i0 + 1;
    if (cols <= 0) return;
    const t0 = performance.now();
    const top = Math.ceil(v.priceMax);
    const bottom = Math.floor(v.priceMin);
    const rowsRaw = top - bottom + 1;
    const rowTicks = Math.max(1, Math.ceil(rowsRaw / 1200));
    this.lastRowTicks = rowTicks;
    const rows = Math.ceil(rowsRaw / rowTicks);
    if (
      this.buf.resize(cols, rows) ||
      !this.img ||
      this.img.width !== cols ||
      this.img.height !== rows
    ) {
      this.img = {
        key: this,
        version: 0,
        width: cols,
        height: rows,
        pixels: new Uint8ClampedArray(this.buf.pixels.buffer, 0, cols * rows * 4),
      };
    }
    const global =
      s.normalize === 'global' ? this.globalCut(v.i0, v.i1, [bottom, top]) : { lo: 0, hi: 1 };
    const colSec = (this.stride * 250) / 1000;
    if (s.heat) {
      this.runs = this.buf.render({
        colAt: (i) => this.col(i),
        i0: v.i0,
        i1: v.i1,
        top,
        rowTicks,
        lut32: lut32Of(this.lut),
        mode: s.normalize,
        global,
        lowerPct: s.cutoffLower,
        upperPct: s.cutoffUpper,
        scale: s.scale,
        minSize: s.minSize,
        largeSize: s.largeOrders ? s.largeOrderSize : 0,
        lifetime:
          s.lifetime && this.lifeLut
            ? { lut: this.lifeLut, maxAgeMs: s.lifetimeMaxSec * 1000 }
            : null,
        lookback: s.lifetime ? Math.ceil(s.lifetimeMaxSec / colSec) : 0,
        maxLevels: s.levelsLimit,
      });
    } else {
      this.buf.pixels.fill(lut32Of(this.lut)[0]!);
    }
    this.stats.heatMs = performance.now() - t0;
    this.stats.cols = cols;
    this.stats.rows = rows;
    this.stats.cells = this.buf.cells;
    // The pixel buffer is the texture (WebGL2) or the off-screen canvas source (Canvas2D).
    this.img.version++;
    const { ctx } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    const paint = painterOf(v);
    paint.setClip({ x: v.plot.x, y: 0, w: v.plot.w, h: v.plot.h });
    const dx = v.xOf(v.i0) - v.slotWidth / 2;
    const dy = v.yOf(top + 0.5);
    paint.image(
      this.img,
      { x: 0, y: 0, w: cols, h: rows },
      { x: dx, y: dy, w: cols * v.slotWidth, h: rows * rowTicks * v.tickPx },
      s.smoothing,
    );
    paint.setClip(null);
    ctx.restore();
  }

  private clip(v: ChartView): void {
    v.ctx.beginPath();
    v.ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    v.ctx.clip();
  }

  private drawLargeOrders(v: ChartView): void {
    const s = this.settings;
    const { ctx } = v;
    ctx.save();
    this.clip(v);
    ctx.strokeStyle = s.largeOrderColor;
    ctx.lineWidth = 1.25;
    const h = this.lastRowTicks * v.tickPx;
    for (const r of this.runs) {
      const x0 = v.xOf(r.slot0) - v.slotWidth / 2;
      const x1 = v.xOf(r.slot1) + v.slotWidth / 2;
      const y = v.yOf(r.px + 0.5);
      ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, h - 1));
    }
    ctx.restore();
  }

  private drawSpoofs(v: ChartView): void {
    const s = this.settings;
    const ev = this.sync.tracker.spoofs;
    const c0 = this.col(v.i0);
    const c1 = this.col(v.i1);
    if (!c0 || !c1 || !ev.length) {
      this.animating = false;
      return;
    }
    const lastT = this.depth()[this.depth().length - 1]?.t ?? c1.t;
    const { ctx } = v;
    ctx.save();
    this.clip(v);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 90);
    const h = Math.max(2, v.tickPx);
    let anim = false;
    for (let k = ev.length - 1; k >= 0; k--) {
      const e = ev[k]!;
      if (e.t1 < c0.t) break;
      if (e.t0 > c1.t) continue;
      const a = Math.max(v.i0, this.slotAtTime(e.t0));
      const b = Math.max(a, this.slotAtTime(e.t1));
      const x0 = v.xOf(a) - v.slotWidth / 2;
      const x1 = v.xOf(b) + v.slotWidth / 2;
      const y = v.yOf(e.px + 0.5);
      const recent = lastT - e.t1 < FLASH_MS;
      if (recent) anim = true;
      const alpha = recent ? 0.35 + 0.6 * pulse : 0.55;
      ctx.fillStyle = rgba(s.spoofColor, recent ? 0.25 * pulse : 0.12);
      ctx.fillRect(x0, y, x1 - x0, h);
      ctx.strokeStyle = rgba(s.spoofColor, alpha);
      ctx.lineWidth = recent ? 1.5 : 1;
      ctx.setLineDash(recent ? [] : [3, 2]);
      ctx.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, h - 1));
      // "Pulled" tick at the moment it vanished.
      ctx.beginPath();
      ctx.moveTo(x1, y - 3);
      ctx.lineTo(x1, y + h + 3);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    this.animating = anim;
  }

  private drawIcebergs(v: ChartView): void {
    const s = this.settings;
    const ev = this.sync.tracker.icebergs;
    const c0 = this.col(v.i0);
    const c1 = this.col(v.i1);
    if (!c0 || !c1 || !ev.length) return;
    const { ctx } = v;
    ctx.save();
    this.clip(v);
    ctx.font = v.font(9, 700);
    ctx.textAlign = 'center';
    for (const e of ev) {
      if (e.last < c0.t || e.t > c1.t) continue;
      const a = Math.max(v.i0, this.slotAtTime(e.t));
      const b = Math.max(a, this.slotAtTime(e.last));
      const y = v.yOf(e.px);
      const xa = v.xOf(a);
      const xb = v.xOf(b);
      ctx.strokeStyle = rgba(s.icebergColor, 0.7);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(xa, y);
      ctx.lineTo(xb, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const r = 6;
      ctx.beginPath();
      ctx.moveTo(xa, y - r);
      ctx.lineTo(xa + r, y);
      ctx.lineTo(xa, y + r);
      ctx.lineTo(xa - r, y);
      ctx.closePath();
      ctx.fillStyle = rgba(s.icebergColor, 0.9);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fillText('I', xa, y + 0.5);
    }
    ctx.restore();
  }

  private drawBestLine(v: ChartView): void {
    const s = this.settings;
    const { ctx, palette: p } = v;
    const bidCol = s.bidColor || p.up;
    const askCol = s.askColor || p.down;
    ctx.save();
    this.clip(v);
    ctx.lineWidth = s.bbaWidth;
    const step = (
      get: (c: DepthColumn) => number,
      colour: (prev: number, cur: number) => string,
    ) => {
      let prev: number | null = null;
      let col = '';
      let lastX = 0;
      for (let i = v.i0; i <= v.i1; i++) {
        const c = this.col(i);
        if (!c) continue;
        const val = get(c);
        if (!Number.isFinite(val)) continue;
        const x0 = v.xOf(i) - v.slotWidth / 2;
        const y = v.yOf(val);
        ctx.beginPath();
        if (prev !== null && prev !== val) {
          col = colour(prev, val);
          ctx.moveTo(x0, v.yOf(prev));
          ctx.lineTo(x0, y);
        } else {
          if (!col) col = colour(val, val);
          ctx.moveTo(x0, y);
        }
        ctx.lineTo(x0 + v.slotWidth, y);
        ctx.strokeStyle = col;
        ctx.stroke();
        prev = val;
        lastX = x0 + v.slotWidth;
      }
      if (s.bbaExtend && prev !== null && v.i1 === v.slotCount - 1) {
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(lastX, v.yOf(prev));
        ctx.lineTo(v.plot.x + v.plot.w, v.yOf(prev));
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    if (s.bbaMode === 'mid') {
      // Stepped mid price: up-steps green, down-steps red; flats keep the last step's colour.
      step(
        (c) => (c.bestBid + c.bestAsk) / 2,
        (a, b) => (b > a ? bidCol : b < a ? askCol : bidCol),
      );
    } else {
      step(
        (c) => c.bestBid,
        () => bidCol,
      );
      step(
        (c) => c.bestAsk,
        () => askCol,
      );
    }
    ctx.restore();
  }

  private drawBubbles(v: ChartView, vt: { list: Trade[]; slots: Int32Array }): void {
    const s = this.settings;
    this.placed = [];
    if (!vt.list.length) return;
    const bubbles = aggregateBubbles(vt.list, vt.slots, {
      clustering: s.clustering,
      calc: s.bubbleCalc,
      minSize: s.minLots,
    });
    if (!bubbles.length) return;
    let max = 0;
    for (const b of bubbles) if (b.size > max) max = b.size;
    const { ctx, palette: p } = v;
    const buy = s.buyColor || p.up;
    const sell = s.sellColor || p.down;
    const fillA = s.bubbleOpacity / 100;
    ctx.save();
    this.clip(v);
    ctx.lineWidth = 1;
    for (const b of bubbles) {
      const r = bubbleRadius(b.size, max, s.bubbleScale);
      const x = v.xOf(b.slot);
      const y = v.yOf(b.px);
      this.placed.push({ b, x, y, r });
      const vol = b.buy + b.sell;
      if (s.bubbleStyle === 'pie' && vol > 0 && b.buy > 0 && b.sell > 0) {
        const split = (b.buy / vol) * Math.PI * 2;
        const start = -Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, r, start, start + split);
        ctx.closePath();
        ctx.fillStyle = rgba(buy, Math.min(1, fillA + 0.35));
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, r, start + split, start + Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = rgba(sell, Math.min(1, fillA + 0.35));
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.stroke();
        continue;
      }
      const col =
        s.bubbleStyle === 'plain'
          ? s.plainColor
          : vol > 0 && b.buy === b.sell
            ? s.plainColor
            : b.buy > b.sell
              ? buy
              : sell;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, fillA);
      ctx.fill();
      ctx.strokeStyle = rgba(col, 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawVolume(v: ChartView, vt: { list: Trade[]; slots: Int32Array }): void {
    const s = this.settings;
    const { ctx, palette: p } = v;
    const r = v.bottom;
    if (r.h <= 0) return;
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = p.divider;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + 0.5);
    ctx.lineTo(r.x + r.w, r.y + 0.5);
    ctx.stroke();
    const { buy, sell } = slotVolumes(vt.list, vt.slots, v.i0, v.i1);
    const n = buy.length;
    let max = 0;
    for (let k = 0; k < n; k++) {
      const val = s.volumeCalc === 'delta' ? Math.abs(buy[k]! - sell[k]!) : buy[k]! + sell[k]!;
      if (val > max) max = val;
    }
    if (max <= 0) return;
    const up = s.buyColor || p.up;
    const dn = s.sellColor || p.down;
    const h = r.h - 14;
    const base = r.y + r.h - 2;
    const bw = Math.max(1, v.slotWidth - (v.slotWidth > 4 ? 1 : 0));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.font = v.font(9);
    ctx.textAlign = 'center';
    for (let k = 0; k < n; k++) {
      const b = buy[k]!;
      const se = sell[k]!;
      const x = v.xOf(v.i0 + k) - bw / 2;
      if (s.volumeCalc === 'delta') {
        const d = b - se;
        if (d === 0) continue;
        const bh = (Math.abs(d) / max) * h;
        ctx.fillStyle = rgba(d > 0 ? up : dn, 0.85);
        ctx.fillRect(x, base - bh, bw, bh);
        if (s.volumeLabels && v.slotWidth >= 18) {
          ctx.fillStyle = p.textSecondary;
          ctx.fillText(formatCompact(Math.round(d)), x + bw / 2, base - bh - 6);
        }
      } else {
        const tot = b + se;
        if (tot <= 0) continue;
        const hb = (b / max) * h;
        const hs = (se / max) * h;
        ctx.fillStyle = rgba(dn, 0.8);
        ctx.fillRect(x, base - hs, bw, hs);
        ctx.fillStyle = rgba(up, 0.8);
        ctx.fillRect(x, base - hs - hb, bw, hb);
        if (s.volumeLabels && v.slotWidth >= 18) {
          ctx.fillStyle = p.textSecondary;
          ctx.fillText(formatCompact(Math.round(tot)), x + bw / 2, base - hs - hb - 6);
        }
      }
    }
    ctx.fillStyle = p.textTertiary;
    ctx.textAlign = 'left';
    ctx.fillText(s.volumeCalc === 'delta' ? 'Delta' : 'Volume', r.x + 4, r.y + 8);
    ctx.restore();
  }

  private drawDom(v: ChartView, profile: readonly Trade[] | null): void {
    const s = this.settings;
    const b = this.book();
    const { ctx, palette: p } = v;
    const r = v.right;
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(r.x, 0, r.w, r.h);
    if (Number.isNaN(b.bestBid)) return;
    const lo = Math.floor(v.priceMin);
    const hi = Math.ceil(v.priceMax);
    const rowTicks = Math.max(1, Math.ceil(14 / Math.max(1e-6, v.tickPx)));
    const rowH = rowTicks * v.tickPx;
    if (profile && profile.length) {
      // Traded volume per row, drawn from the right edge behind the resting sizes.
      const vp = new Map<number, number>();
      let vmax = 0;
      for (const t of profile) {
        const k = Math.floor(t.px / rowTicks) * rowTicks;
        const q = (vp.get(k) ?? 0) + t.qty;
        vp.set(k, q);
        if (q > vmax) vmax = q;
      }
      ctx.fillStyle = rgba(p.volume || '#808080', 0.35);
      for (const [px, q] of vp) {
        if (px + rowTicks < lo || px > hi) continue;
        const w = (q / vmax) * (r.w * 0.6);
        ctx.fillRect(r.x + r.w - w, v.yOf(px + rowTicks - 0.5) + 1, w, Math.max(1, rowH - 2));
      }
    }
    const lim = s.levelsLimit > 0 ? s.levelsLimit : Infinity;
    let max = 0;
    const rows: { px: number; q: number; ask: boolean }[] = [];
    for (let k = Math.floor(lo / rowTicks) * rowTicks; k <= hi; k += rowTicks) {
      let q = 0;
      let ask = false;
      for (let px = k; px < k + rowTicks; px++) {
        if (px <= b.bestBid - lim || px >= b.bestAsk + lim) continue;
        const a = b.asks.get(px);
        const bd = b.bids.get(px);
        if (a) {
          q += a;
          ask = true;
        }
        if (bd) q += bd;
      }
      if (q > 0) {
        rows.push({ px: k, q, ask });
        max = Math.max(max, q);
      }
    }
    const askCol = s.askColor || p.down;
    const bidCol = s.bidColor || p.up;
    const labelW = s.domLabels ? 26 : 2;
    const priceW = s.domLabels ? 52 : 2;
    const barX = r.x + labelW;
    const barW = Math.max(4, r.w - labelW - priceW);
    ctx.font = v.font(10);
    for (const row of rows) {
      const y = v.yOf(row.px + rowTicks - 0.5);
      const isTouch = row.px <= b.bestBid && row.px + rowTicks > b.bestBid;
      if (isTouch) {
        ctx.fillStyle = rgba(askCol, 0.85);
        ctx.fillRect(r.x, y, r.w, rowH - 1);
      }
      ctx.fillStyle = rgba(row.ask ? askCol : bidCol, isTouch ? 0.6 : 0.22 + (row.q / max) * 0.5);
      ctx.fillRect(barX, y + 1, Math.max(1, (row.q / max) * barW), Math.max(1, rowH - 2));
      if (s.domLabels && rowH >= 10) {
        ctx.fillStyle = p.textSoft;
        ctx.textAlign = 'right';
        ctx.fillText(formatCompact(Math.round(row.q * 1000) / 1000), barX - 4, y + rowH / 2);
        ctx.fillStyle = isTouch ? '#fff' : p.textSecondary;
        ctx.font = v.font(10, isTouch ? 700 : 400);
        ctx.fillText(formatPrice(row.px, v.instrument), r.x + r.w - 4, y + rowH / 2);
        ctx.font = v.font(10);
      }
    }
  }

  /** Resting size at a slot and price (ticks), 0 when none. */
  sizeAt(slot: number, px: number): { qty: number; side: 'bid' | 'ask' | null; t: number } {
    const c = this.col(slot);
    if (!c) return { qty: 0, side: null, t: 0 };
    const rowTicks = this.lastRowTicks;
    const base = rowTicks > 1 ? Math.floor(px / rowTicks) * rowTicks : px;
    let qty = 0;
    for (let k = 0; k < c.pxs.length; k++) {
      const p = c.pxs[k]!;
      if (p >= base && p < base + rowTicks) qty = Math.max(qty, c.qtys[k]!);
    }
    const side = qty > 0 ? (px <= c.bestBid ? 'bid' : 'ask') : null;
    return { qty, side, t: c.t };
  }

  private drawReadout(v: ChartView): void {
    const ch = v.crosshair!;
    if (ch.x < v.plot.x || ch.x > v.plot.x + v.plot.w || ch.y > v.plot.h) return;
    const { qty } = this.sizeAt(ch.slot, ch.px);
    const text = `${formatPrice(ch.px, v.instrument)} · ${formatCompact(Math.round(qty * 100) / 100)}`;
    const { ctx, palette: p } = v;
    ctx.save();
    ctx.font = v.font(10, 600, true);
    const w = ctx.measureText(text).width + 10;
    const x = Math.min(ch.x + 12, v.plot.x + v.plot.w - w - 2);
    const y = Math.max(2, ch.y - 22);
    ctx.fillStyle = p.surface3;
    ctx.fillRect(x, y, w, 16);
    ctx.fillStyle = p.textPrimary;
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 5, y + 8);
    ctx.restore();
  }

  /** Bubble or cell under (x, y) in canvas CSS px. */
  hitTest(v: ChartView, x: number, y: number): HeatHit | null {
    if (x < v.plot.x || x > v.plot.x + v.plot.w || y < 0 || y > v.plot.h) return null;
    if (this.settings.bubbles) {
      const b = bubbleAt(this.placed, x, y);
      if (b) return { kind: 'bubble', bubble: b.b, x: b.x, y: b.y };
    }
    const slot = v.slotAt(x);
    const px = Math.round(v.pxAt(y));
    const at = this.sizeAt(slot, px);
    if (!at.t) return null;
    const hit: HeatHit = { kind: 'cell', t: at.t, px, qty: at.qty, side: at.side, x, y };
    if (this.settings.spoofs)
      hit.spoof = this.spoofEvents.find((e) => e.px === px && at.t >= e.t0 && at.t <= e.t1);
    if (this.settings.icebergs)
      hit.iceberg = this.icebergEvents.find(
        (e) => e.px === px && at.t >= e.t - 1000 && at.t <= e.last + 1000,
      );
    return hit;
  }
}
