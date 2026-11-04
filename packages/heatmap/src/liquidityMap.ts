import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import {
  formatCompact,
  formatPrice,
  type DepthColumn,
  type OrderBook,
  type Trade,
} from '@htflow/market-data';
import { buildLut, GRADIENTS, heatIndex, percentile, type HeatScale } from './gradient';

export interface HeatmapSettings {
  gradient: string;
  brightness: number;
  /** Upper cut-off percentile (default 98). */
  cutoffUpper: number;
  /** Lower cut-off percentile (default 20). */
  cutoffLower: number;
  scale: HeatScale;
  bubbles: boolean;
  /** Hide trade bubbles smaller than this. */
  minLots: number;
  bubbleScale: number;
  bestBidAsk: boolean;
  domColumn: boolean;
}

export const DEFAULT_HEATMAP: HeatmapSettings = {
  gradient: 'ruby',
  brightness: 100,
  cutoffUpper: 98,
  cutoffLower: 20,
  scale: 'sqrt',
  bubbles: true,
  minLots: 1,
  bubbleScale: 50,
  bestBidAsk: true,
  domColumn: true,
};

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Liquidity map (P11 / P46 board 22): resting-depth history as a heat texture (one pixel per
 * column × price row, scaled up without smoothing), stepped best price, trade bubbles, DOM column.
 */
export class LiquidityMapLayer implements ChartLayer {
  readonly id = 'liquidity-map';
  settings: HeatmapSettings;
  /** Base columns per slot (250 ms base → 1 s = 4, 5 s = 20). */
  stride = 1;
  private lut: Uint8ClampedArray;
  private lutKey = '';
  private off: HTMLCanvasElement | null = null;
  private img: ImageData | null = null;

  constructor(
    private depth: () => DepthColumn[],
    private trades: (from: number, to: number) => Trade[],
    private book: () => OrderBook,
    settings: Partial<HeatmapSettings> = {},
  ) {
    this.settings = { ...DEFAULT_HEATMAP, ...settings };
    this.lut = buildLut(
      GRADIENTS[this.settings.gradient] ?? GRADIENTS.ruby!,
      this.settings.brightness,
    );
  }

  rightGutter() {
    return this.settings.domColumn ? 150 : 0;
  }

  private col(i: number): DepthColumn | undefined {
    const d = this.depth();
    return d[Math.min(d.length - 1, i * this.stride)];
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
    const span = Math.max(30, hi - lo);
    return [lo - span * 0.6, hi + span * 0.6];
  }

  draw(v: ChartView): void {
    const s = this.settings;
    const key = `${s.gradient}:${s.brightness}`;
    if (key !== this.lutKey) {
      this.lut = buildLut(GRADIENTS[s.gradient] ?? GRADIENTS.ruby!, s.brightness);
      this.lutKey = key;
    }
    this.drawHeat(v);
    if (s.bestBidAsk) this.drawBestLine(v);
    if (s.bubbles) this.drawBubbles(v);
    if (s.domColumn) this.drawDom(v);
  }

  private drawHeat(v: ChartView): void {
    const cols = v.i1 - v.i0 + 1;
    if (cols <= 0) return;
    const top = Math.ceil(v.priceMax);
    const bottom = Math.floor(v.priceMin);
    const rowsRaw = top - bottom + 1;
    const rowTicks = Math.max(1, Math.ceil(rowsRaw / 1200));
    const rows = Math.ceil(rowsRaw / rowTicks);
    if (!this.off) this.off = document.createElement('canvas');
    if (!this.img || this.img.width !== cols || this.img.height !== rows) {
      this.off.width = cols;
      this.off.height = rows;
      const octx = this.off.getContext('2d')!;
      this.img = octx.createImageData(cols, rows);
    }
    const data = this.img.data;
    // Cut-offs from a sample of visible values.
    const sample = new Float32Array(Math.min(20000, cols * 40));
    let n = 0;
    const stepI = Math.max(1, Math.floor(cols / 400));
    for (let i = v.i0; i <= v.i1 && n < sample.length; i += stepI) {
      const c = this.col(i);
      if (!c) continue;
      for (let k = 0; k < c.qtys.length && n < sample.length; k += 2) {
        const px = c.pxs[k]!;
        if (px >= bottom && px <= top) sample[n++] = c.qtys[k]!;
      }
    }
    const sub = sample.subarray(0, n);
    const hi = percentile(sub, this.settings.cutoffUpper / 100);
    const lo = percentile(sub, this.settings.cutoffLower / 100);
    const lut = this.lut;
    const bg0 = lut[0]!;
    const bg1 = lut[1]!;
    const bg2 = lut[2]!;
    for (let p = 0; p < data.length; p += 4) {
      data[p] = bg0;
      data[p + 1] = bg1;
      data[p + 2] = bg2;
      data[p + 3] = 255;
    }
    for (let i = v.i0; i <= v.i1; i++) {
      const c = this.col(i);
      if (!c) continue;
      const x = i - v.i0;
      for (let k = 0; k < c.pxs.length; k++) {
        const px = c.pxs[k]!;
        if (px < bottom || px > top) continue;
        const row = Math.floor((top - px) / rowTicks);
        const idx = heatIndex(c.qtys[k]!, lo, hi, this.settings.scale);
        const o = (row * cols + x) * 4;
        if (idx > 0 && idx * 4 >= 0) {
          // Keep the hottest value when rows are merged.
          const cur = data[o]! + data[o + 1]! + data[o + 2]!;
          const li = idx * 4;
          if (lut[li]! + lut[li + 1]! + lut[li + 2]! >= cur) {
            data[o] = lut[li]!;
            data[o + 1] = lut[li + 1]!;
            data[o + 2] = lut[li + 2]!;
          }
        }
      }
    }
    const octx = this.off.getContext('2d')!;
    octx.putImageData(this.img, 0, 0);
    const { ctx } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const dx = v.xOf(v.i0) - v.slotWidth / 2;
    const dy = v.yOf(top + 0.5);
    ctx.drawImage(
      this.off,
      0,
      0,
      cols,
      rows,
      dx,
      dy,
      cols * v.slotWidth,
      rows * rowTicks * v.tickPx,
    );
    ctx.restore();
  }

  private drawBestLine(v: ChartView): void {
    const { ctx, palette: p } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.lineWidth = 2;
    // Stepped mid price: up-steps green, down-steps red; flats keep the last step's colour.
    let prev: number | null = null;
    let colour = p.up;
    for (let i = v.i0; i <= v.i1; i++) {
      const c = this.col(i);
      if (!c) continue;
      const mid = (c.bestBid + c.bestAsk) / 2;
      const x0 = v.xOf(i) - v.slotWidth / 2;
      const y = v.yOf(mid);
      ctx.beginPath();
      if (prev !== null && prev !== mid) {
        colour = mid > prev ? p.up : p.down;
        ctx.moveTo(x0, v.yOf(prev));
        ctx.lineTo(x0, y);
      } else ctx.moveTo(x0, y);
      ctx.lineTo(x0 + v.slotWidth, y);
      ctx.strokeStyle = colour;
      ctx.stroke();
      prev = mid;
    }
    ctx.restore();
  }

  private drawBubbles(v: ChartView): void {
    const c0 = this.col(v.i0);
    const c1 = this.col(v.i1);
    if (!c0 || !c1) return;
    const span = this.stride * 250;
    const trades = this.trades(c0.t - span, c1.t + span);
    if (!trades.length) return;
    // Aggregate per column and side.
    const agg = new Map<string, { i: number; side: string; qty: number; pxq: number }>();
    let colIdx = v.i0;
    for (const t of trades) {
      while (colIdx < v.i1 && (this.col(colIdx + 1)?.t ?? Infinity) <= t.ts) colIdx++;
      const k = `${colIdx}:${t.side}`;
      const e = agg.get(k) ?? { i: colIdx, side: t.side, qty: 0, pxq: 0 };
      e.qty += t.qty;
      e.pxq += t.px * t.qty;
      agg.set(k, e);
    }
    let max = 0;
    for (const e of agg.values()) max = Math.max(max, e.qty);
    const { ctx, palette: p } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    const maxR = 6 + this.settings.bubbleScale * 0.5;
    for (const e of agg.values()) {
      if (e.qty < this.settings.minLots) continue;
      const r = Math.max(2.5, Math.sqrt(e.qty / max) * maxR);
      const x = v.xOf(e.i);
      const y = v.yOf(e.pxq / e.qty);
      const col = e.side === 'buy' ? p.up : p.down;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(col, 0.35);
      ctx.fill();
      ctx.strokeStyle = rgba(col, 0.9);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDom(v: ChartView): void {
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
    let max = 0;
    const rows: { px: number; q: number; ask: boolean }[] = [];
    for (let k = Math.floor(lo / rowTicks) * rowTicks; k <= hi; k += rowTicks) {
      let q = 0;
      let ask = false;
      for (let px = k; px < k + rowTicks; px++) {
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
    const barX = r.x + 26;
    const barW = r.w - 26 - 52;
    ctx.font = v.font(10);
    for (const row of rows) {
      const y = v.yOf(row.px + rowTicks - 0.5);
      const isTouch = row.px <= b.bestBid && row.px + rowTicks > b.bestBid;
      if (isTouch) {
        ctx.fillStyle = rgba(p.down, 0.85);
        ctx.fillRect(r.x, y, r.w, rowH - 1);
      }
      ctx.fillStyle = rgba(row.ask ? p.down : p.up, isTouch ? 0.6 : 0.22 + (row.q / max) * 0.5);
      ctx.fillRect(barX, y + 1, Math.max(1, (row.q / max) * barW), Math.max(1, rowH - 2));
      if (rowH >= 10) {
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
}
