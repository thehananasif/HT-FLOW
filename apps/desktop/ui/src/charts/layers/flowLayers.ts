import { barsRange, type ChartLayer, type ChartView } from '@htflow/chart-engine';
import { diagonalImbalances, mergeRows, stackedZones } from '@htflow/footprint';
import { buildLut, GRADIENTS, heatIndex, percentile } from '@htflow/heatmap';
import {
  BarSeries,
  formatCompact,
  type Bar,
  type DepthColumn,
  type MarketStore,
} from '@htflow/market-data';
import { alpha } from '@htflow/ui-kit';
import { withColors, type ChartTypeSettings } from './settings';

type Get = () => ChartTypeSettings;

const ROW_STEPS = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
/** Smallest row size (ticks) that keeps rows at least minPx tall. */
export function rowTicksAt(tickPx: number, minPx: number): number {
  for (const s of ROW_STEPS) if (s * tickPx >= minPx) return s;
  return 10000;
}

function clipPlot(v: ChartView): void {
  v.ctx.beginPath();
  v.ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
  v.ctx.clip();
}

/** Volume Histogram (P33 #7): volume-at-price histogram inside every bar, max level highlighted. */
export class VolumeHistogramLayer implements ChartLayer {
  readonly id = 'volume-histogram';
  constructor(
    private series: () => BarSeries,
    private get: Get,
  ) {}

  priceRange(i0: number, i1: number) {
    return barsRange(this.series().bars, i0, i1);
  }

  draw(v: ChartView): void {
    const s = this.get();
    const st = s.volumeHistogram;
    const p = withColors(v.palette, s.colors);
    const bars = this.series().bars;
    const ctx = v.ctx;
    clipPlot(v);
    const rt = rowTicksAt(v.tickPx, 3);
    const rowH = Math.max(1, rt * v.tickPx - 1);
    const w = v.slotWidth * (st.widthPct / 100) - 3;
    ctx.font = v.font(Math.min(11, Math.max(8, rowH - 2)), 400, true);
    ctx.textBaseline = 'middle';
    for (let i = v.i0; i <= v.i1; i++) {
      const b = bars[i];
      if (!b) continue;
      const x0 = v.xOf(i) - v.slotWidth / 2 + 2;
      // OHLC spine on the left edge
      const up = b.c >= b.o;
      ctx.strokeStyle = up ? p.up : p.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, v.yOf(b.h));
      ctx.lineTo(x0 + 0.5, v.yOf(b.l));
      ctx.moveTo(x0 - 2, v.yOf(b.o));
      ctx.lineTo(x0 + 0.5, v.yOf(b.o));
      ctx.moveTo(x0 + 0.5, v.yOf(b.c));
      ctx.lineTo(x0 + 3, v.yOf(b.c));
      ctx.stroke();
      if (w < 2) continue;
      const rows = mergeRows(b, rt);
      let max = 0;
      let maxPx = Number.NaN;
      for (const r of rows)
        if (r.vol > max) {
          max = r.vol;
          maxPx = r.px;
        }
      if (max <= 0) continue;
      const showText = st.showValues && rowH >= 9 && w >= 34;
      for (const r of rows) {
        const y = v.yOf(r.px + rt - 0.5);
        const len = Math.max(1, (r.vol / max) * w);
        const isMax = st.highlightMax && r.px === maxPx;
        if (isMax) ctx.fillStyle = alpha(p.warning, 0.85);
        else if (st.colorBy === 'delta')
          ctx.fillStyle = alpha(r.delta >= 0 ? p.up : p.down, 0.25 + 0.5 * (Math.abs(r.delta) / r.vol || 0));
        else ctx.fillStyle = alpha(p.volume, 0.75);
        ctx.fillRect(x0 + 3, y, len, rowH);
        if (showText) {
          ctx.fillStyle = isMax ? p.chartBg : p.textPrimary;
          ctx.textAlign = 'left';
          ctx.fillText(formatCompact(r.vol), x0 + 5, y + rowH / 2);
        }
      }
    }
  }
}

/** Imbalance Chart (P33 #5): diagonal imbalance cells + stacked zones extended until filled. */
export class ImbalanceLayer implements ChartLayer {
  readonly id = 'imbalance';
  constructor(
    private series: () => BarSeries,
    private get: Get,
  ) {}

  priceRange(i0: number, i1: number) {
    return barsRange(this.series().bars, i0, i1);
  }

  draw(v: ChartView): void {
    const s = this.get();
    const st = s.imbalance;
    const p = withColors(v.palette, s.colors);
    const bars = this.series().bars;
    const ctx = v.ctx;
    clipPlot(v);
    const rt = rowTicksAt(v.tickPx, 4);
    const rowH = Math.max(1, rt * v.tickPx - 1);
    const ratio = st.ratio / 100;
    const cw = Math.max(2, v.slotWidth * 0.8);
    // zones may start before the visible range and extend into it
    const from = Math.max(0, v.i0 - 400);
    for (let i = from; i <= v.i1; i++) {
      const b = bars[i];
      if (!b) continue;
      const rows = mergeRows(b, rt);
      const imb = diagonalImbalances(rows, ratio, st.minVolume);
      if (i >= v.i0) {
        const x = v.xOf(i) - cw / 2;
        for (let k = 0; k < rows.length; k++) {
          const f = imb[k]!;
          if (!f.buy && !f.sell) continue;
          const y = v.yOf(rows[k]!.px + rt - 0.5);
          if (f.buy) {
            ctx.fillStyle = alpha(p.up, 0.75);
            ctx.fillRect(x, y, cw / (f.sell ? 2 : 1), rowH);
          }
          if (f.sell) {
            ctx.fillStyle = alpha(p.down, 0.75);
            ctx.fillRect(x + (f.buy ? cw / 2 : 0), y, cw / (f.buy ? 2 : 1), rowH);
          }
        }
      }
      if (!st.extendZones) continue;
      for (const [lo, hi, side] of stackedZones(rows, imb, st.stacked)) {
        let end = bars.length - 1;
        for (let j = i + 1; j < bars.length; j++) {
          const n = bars[j]!;
          if (side === 'buy' ? n.l < lo : n.h > hi + rt - 1) {
            end = j;
            break;
          }
        }
        if (end < v.i0) continue;
        const x0 = v.xOf(i);
        const x1 = v.xOf(end);
        const y0 = v.yOf(hi + rt - 0.5);
        const y1 = v.yOf(lo - 0.5);
        const col = side === 'buy' ? p.up : p.down;
        ctx.fillStyle = alpha(col, 0.14);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = alpha(col, 0.6);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, x1 - x0, y1 - y0);
      }
    }
  }
}

function lowerBoundT(depth: readonly DepthColumn[], t: number): number {
  let lo = 0;
  let hi = depth.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (depth[m]!.t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** On-Chart Liquidity Map (P33 #8): recorded resting depth drawn as heat behind the candles. */
export class OnChartLiquidityLayer implements ChartLayer {
  readonly id = 'onchart-liquidity';
  private lutKey = '';
  private lut: Uint8ClampedArray = new Uint8ClampedArray(1024);
  constructor(
    private store: MarketStore,
    private series: () => BarSeries,
    private get: Get,
  ) {}

  draw(v: ChartView): void {
    const st = this.get().liquidity;
    if (this.lutKey !== st.gradient) {
      this.lut = buildLut(GRADIENTS[st.gradient] ?? GRADIENTS.classic!, 100);
      this.lutKey = st.gradient;
    }
    const depth = this.store.depth;
    const bars = this.series().bars;
    if (!depth.length || !bars.length) return;
    const ctx = v.ctx;
    clipPlot(v);
    const rt = rowTicksAt(v.tickPx, 2);
    const rowH = Math.max(1, rt * v.tickPx);
    const cells: { x: number; w: number; y: number; q: number }[] = [];
    const lo = Math.floor(v.priceMin / rt) * rt;
    const hi = Math.ceil(v.priceMax / rt) * rt;
    for (let i = v.i0; i <= v.i1; i++) {
      const b = bars[i];
      if (!b) continue;
      const t0 = b.t;
      const t1 = bars[i + 1]?.t ?? Infinity;
      const a = lowerBoundT(depth, t0);
      const z = Math.min(depth.length, lowerBoundT(depth, t1));
      if (z <= a) continue;
      const n = Math.min(6, z - a);
      const acc = new Map<number, number>();
      for (let k = 0; k < n; k++) {
        const col = depth[a + Math.floor(((z - a - 1) * k) / Math.max(1, n - 1))]!;
        for (let j = 0; j < col.pxs.length; j++) {
          const px = col.pxs[j]!;
          if (px < lo || px > hi) continue;
          const r = Math.floor(px / rt) * rt;
          acc.set(r, (acc.get(r) ?? 0) + col.qtys[j]! / n);
        }
      }
      const x = v.xOf(i) - v.slotWidth / 2;
      for (const [r, q] of acc) cells.push({ x, w: v.slotWidth + 0.5, y: v.yOf(r + rt - 0.5), q });
    }
    if (!cells.length) return;
    const sample = Float32Array.from(cells, (c) => c.q);
    const top = percentile(sample, st.upperCut / 100);
    ctx.globalAlpha = st.opacity / 100;
    const lut = this.lut;
    for (const c of cells) {
      const k = heatIndex(c.q, 0, top || 1, 'sqrt');
      if (k < 8) continue;
      ctx.fillStyle = `rgb(${lut[k * 4]},${lut[k * 4 + 1]},${lut[k * 4 + 2]})`;
      ctx.fillRect(c.x, c.y, c.w, rowH);
    }
    ctx.globalAlpha = 1;
  }
}

/** Cumulative delta sub-pane (Order Flow Light). */
export class CvdPaneLayer implements ChartLayer {
  readonly id = 'cvd-pane';
  height = 90;
  constructor(
    private series: () => BarSeries,
    private get: Get,
  ) {}

  bottomHeight(): number {
    return this.get().orderFlowLight.showCvd ? this.height : 0;
  }

  draw(v: ChartView): void {
    if (!this.get().orderFlowLight.showCvd) return;
    const p = withColors(v.palette, this.get().colors);
    const bars = this.series().bars;
    const r = v.bottom;
    const ctx = v.ctx;
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = p.divider;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + 0.5);
    ctx.lineTo(r.x + r.w, r.y + 0.5);
    ctx.stroke();
    const cvd: number[] = [];
    let acc = 0;
    for (let i = 0; i <= v.i1 && i < bars.length; i++) {
      acc += bars[i]!.delta;
      cvd.push(acc);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = v.i0; i <= v.i1 && i < cvd.length; i++) {
      lo = Math.min(lo, cvd[i]!);
      hi = Math.max(hi, cvd[i]!);
    }
    if (!Number.isFinite(lo)) return;
    if (hi === lo) hi = lo + 1;
    const y = (x: number) => r.y + 6 + (1 - (x - lo) / (hi - lo)) * (r.h - 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    const bw = Math.max(1, v.slotWidth * 0.6);
    for (let i = v.i0; i <= v.i1 && i < cvd.length; i++) {
      const prev = i > 0 ? cvd[i - 1]! : 0;
      const cur = cvd[i]!;
      ctx.fillStyle = cur >= prev ? p.up : p.down;
      const ya = y(prev);
      const yb = y(cur);
      ctx.fillRect(v.xOf(i) - bw / 2, Math.min(ya, yb), bw, Math.max(1, Math.abs(yb - ya)));
    }
    ctx.restore();
    ctx.fillStyle = p.textSecondary;
    ctx.font = v.font(10);
    ctx.textAlign = 'left';
    ctx.fillText(`CVD ${formatCompact(cvd[Math.min(v.i1, cvd.length - 1)] ?? 0)}`, r.x + 6, r.y + 10);
  }
}

/** Big-trade bubbles on bars (Order Flow Light). */
export class BigTradesLayer implements ChartLayer {
  readonly id = 'big-trades';
  constructor(
    private store: MarketStore,
    private series: () => BarSeries,
    private get: Get,
  ) {}

  draw(v: ChartView): void {
    const s = this.get();
    if (!s.orderFlowLight.showBubbles) return;
    const min = s.orderFlowLight.bigTrade;
    const p = withColors(v.palette, s.colors);
    const bars = this.series().bars;
    const ctx = v.ctx;
    clipPlot(v);
    let drawn = 0;
    for (let i = v.i0; i <= v.i1 && drawn < 3000; i++) {
      const b = bars[i];
      if (!b || b.vol < min) continue;
      const x = v.xOf(i);
      for (const tr of this.store.tradesBetween(b.t, b.tEnd)) {
        if (tr.qty < min || tr.side === 'unknown') continue;
        const rad = Math.min(v.slotWidth * 0.45, 3 + Math.sqrt(tr.qty / Math.max(min, 1e-9)) * 3);
        const col = tr.side === 'buy' ? p.up : p.down;
        ctx.fillStyle = alpha(col, 0.35);
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(x, v.yOf(tr.px), rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (++drawn >= 3000) break;
      }
    }
  }
}

/** Higher-timeframe candles drawn as tinted boxes behind lower-timeframe candles (P33 #11). */
export class MtfBoxesLayer implements ChartLayer {
  readonly id = 'mtf-boxes';
  constructor(
    private series: () => BarSeries,
    private higher: () => { series: BarSeries; label: string }[],
    private get: Get,
  ) {}

  draw(v: ChartView): void {
    const s = this.get();
    const p = withColors(v.palette, s.colors);
    const bars = this.series().bars;
    if (!bars.length) return;
    const ctx = v.ctx;
    clipPlot(v);
    const t0 = bars[Math.max(0, v.i0)]!.t;
    const tEnd = bars[Math.min(bars.length - 1, v.i1)]!.tEnd;
    const op = s.mtf.opacity / 100;
    const hs = this.higher();
    hs.forEach(({ series, label }, level) => {
      const hb = series.bars;
      let k = Math.max(0, series.indexAt(t0));
      for (; k < hb.length; k++) {
        const h = hb[k]!;
        if (h.t > tEnd) break;
        const next = hb[k + 1]?.t ?? Infinity;
        const a = firstAtOrAfter(bars, h.t);
        const z = firstAtOrAfter(bars, next) - 1;
        if (z < a) continue;
        const x0 = v.xOf(a) - v.slotWidth / 2;
        const x1 = v.xOf(z) + v.slotWidth / 2;
        const col = h.c >= h.o ? p.up : p.down;
        const fade = op / (level + 1);
        ctx.fillStyle = alpha(col, fade * 0.5);
        ctx.fillRect(x0, v.yOf(h.h), x1 - x0, v.yOf(h.l) - v.yOf(h.h));
        const yo = v.yOf(Math.max(h.o, h.c));
        const yc = v.yOf(Math.min(h.o, h.c));
        ctx.fillStyle = alpha(col, fade);
        ctx.fillRect(x0, yo, x1 - x0, Math.max(1, yc - yo));
        ctx.strokeStyle = alpha(col, Math.min(1, fade * 3));
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(v.yOf(h.h)) + 0.5, x1 - x0, v.yOf(h.l) - v.yOf(h.h));
        if (x1 - x0 > 40) {
          ctx.fillStyle = alpha(p.textSecondary, 0.8);
          ctx.font = v.font(9);
          ctx.textAlign = 'left';
          ctx.fillText(label, x0 + 3, v.yOf(h.h) - 6);
        }
      }
    });
  }
}

function firstAtOrAfter(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars[m]!.t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
