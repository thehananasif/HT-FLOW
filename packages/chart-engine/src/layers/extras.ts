import { formatCompact, formatPrice, type Bar, type BarSeries } from '@htflow/market-data';
import type { ChartLayer, ChartView, DataRow } from '../types';
import { rgba } from './util';

/** Large faded symbol + timeframe text behind the bars (P08 watermark). */
export class WatermarkLayer implements ChartLayer {
  readonly id = 'watermark';
  visible = false;
  color = '';
  /** Font size in px; 0 = auto (fits the pane). */
  size = 0;
  opacity = 0.08;
  constructor(public text: () => string) {}

  draw(v: ChartView): void {
    if (!this.visible) return;
    const t = this.text();
    if (!t) return;
    const { ctx, palette: p } = v;
    const size =
      this.size > 0 ? this.size : Math.max(18, Math.min(72, v.plot.w / (t.length * 0.62)));
    ctx.save();
    ctx.font = v.font(size, 700);
    ctx.textAlign = 'center';
    ctx.fillStyle = this.color ? this.color : rgba(p.textPrimary, this.opacity);
    if (this.color) ctx.globalAlpha = Math.max(0.02, Math.min(1, this.opacity * 4));
    ctx.fillText(t, v.plot.x + v.plot.w / 2, v.plot.y + v.plot.h / 2);
    ctx.restore();
  }
}

/** Index of the visible bar with the highest high and the lowest low. */
export function visibleHighLow(
  bars: readonly Bar[],
  i0: number,
  i1: number,
): { hi: number; lo: number } | null {
  let hi = -1;
  let lo = -1;
  for (let i = Math.max(0, i0); i <= i1 && i < bars.length; i++) {
    if (hi < 0 || bars[i]!.h > bars[hi]!.h) hi = i;
    if (lo < 0 || bars[i]!.l < bars[lo]!.l) lo = i;
  }
  return hi < 0 ? null : { hi, lo };
}

/** Labels at the highest high and lowest low of the visible range (P08 high/low marks). */
export class HighLowMarksLayer implements ChartLayer {
  readonly id = 'high-low';
  visible = false;
  color = '';
  constructor(private series: () => BarSeries) {}

  draw(v: ChartView): void {
    if (!this.visible) return;
    const bars = this.series().bars;
    const hl = visibleHighLow(bars, Math.max(v.i0, v.slotAt(v.plot.x)), v.i1);
    if (!hl) return;
    const { ctx, palette: p } = v;
    const col = this.color || p.textSoft;
    ctx.font = v.font(10, 600);
    ctx.textBaseline = 'middle';
    const mark = (i: number, px: number, above: boolean) => {
      const x = v.xOf(i);
      const yBar = v.yOf(px);
      const inv = v.inverted ? -1 : 1;
      const y = yBar + (above ? -12 : 12) * inv;
      const label = formatPrice(px, v.instrument);
      const w = ctx.measureText(label).width;
      const right = x + w + 14 < v.plot.x + v.plot.w;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, yBar + (above ? -2 : 2) * inv);
      ctx.lineTo(x, y);
      ctx.lineTo(right ? x + 6 : x - 6, y);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(label, right ? x + 8 : x - 8, y);
    };
    mark(hl.hi, bars[hl.hi]!.h, true);
    mark(hl.lo, bars[hl.lo]!.l, false);
  }
}

/**
 * Trading-session background: shades the time outside the session window (RTH / custom) and
 * optionally alternates session colours (P08 "background colour per session").
 */
export class SessionShadeLayer implements ChartLayer {
  readonly id = 'session-shade';
  visible = false;
  /** Session window in ms after 00:00 UTC; begin > end wraps over midnight. */
  beginMs = 0;
  endMs = 86_400_000;
  color = '';
  alternate = false;
  constructor(private series: () => BarSeries) {}

  /** True when t (epoch ms) is inside the session window. */
  inSession(t: number): boolean {
    const m = ((t % 86_400_000) + 86_400_000) % 86_400_000;
    if (this.beginMs === this.endMs) return true;
    return this.beginMs < this.endMs
      ? m >= this.beginMs && m < this.endMs
      : m >= this.beginMs || m < this.endMs;
  }

  draw(v: ChartView): void {
    if (!this.visible) return;
    const bars = this.series().bars;
    const { ctx, palette: p } = v;
    const shade = this.color || rgba(p.textPrimary, 0.05);
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.fillStyle = shade;
    for (let i = v.i0; i <= v.i1; i++) {
      const b = bars[i];
      if (!b) continue;
      const out = !this.inSession(b.t);
      const day = Math.floor((b.t - this.beginMs) / 86_400_000);
      if (out || (this.alternate && day % 2 === 0)) {
        const x = v.xOf(i) - v.slotWidth / 2;
        ctx.globalAlpha = out ? 1 : 0.5;
        ctx.fillRect(x, 0, v.slotWidth + 0.5, v.plot.h);
      }
    }
    ctx.restore();
  }
}

export interface CompareSeries {
  id: string;
  label: string;
  color: string;
  series: () => BarSeries | null;
}

/** Close at or before time t (binary search), or null. */
export function closeAtOrBefore(bars: readonly Bar[], t: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans < 0 ? null : bars[ans]!.c;
}

/**
 * Compare / overlay instruments as normalised % lines (P08): each overlay is rebased to the main
 * series' first visible close, so the line shows relative performance on the main price scale.
 */
export class CompareLayer implements ChartLayer {
  readonly id = 'compare';
  items: CompareSeries[] = [];
  /** Include overlays in auto-scale. */
  autoScale = true;
  private lastBaseIndex = 0;
  constructor(private main: () => BarSeries | null) {}

  private mapped(
    it: CompareSeries,
    baseIdx: number,
  ): { at(i: number): number | null; pctAt(i: number): number | null } | null {
    const m = this.main()?.bars;
    const o = it.series()?.bars;
    if (!m || !o || !m.length || !o.length) return null;
    const b = m[Math.min(m.length - 1, Math.max(0, baseIdx))]!;
    const ob = closeAtOrBefore(o, b.t) ?? o[0]!.c;
    if (!ob) return null;
    return {
      at: (i) => {
        const bar = m[i];
        if (!bar) return null;
        const c = closeAtOrBefore(o, bar.t);
        return c === null ? null : (b.c * c) / ob;
      },
      pctAt: (i) => {
        const bar = m[i];
        if (!bar) return null;
        const c = closeAtOrBefore(o, bar.t);
        return c === null ? null : (c / ob - 1) * 100;
      },
    };
  }

  priceRange(i0: number, i1: number): [number, number] | null {
    if (!this.autoScale || !this.items.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of this.items) {
      const mp = this.mapped(it, i0 + 1);
      if (!mp) continue;
      for (let i = i0; i <= i1; i++) {
        const y = mp.at(i);
        if (y === null) continue;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    return Number.isFinite(lo) ? [lo, hi] : null;
  }

  dataWindow(i: number): DataRow[] {
    const out: DataRow[] = [];
    for (const it of this.items) {
      const pct = this.mapped(it, this.lastBaseIndex)?.pctAt(i);
      if (pct !== null && pct !== undefined)
        out.push({
          label: it.label,
          value: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
          color: it.color,
        });
    }
    return out;
  }

  draw(v: ChartView): void {
    if (!this.items.length) return;
    const { ctx } = v;
    const base = Math.max(v.i0, v.slotAt(v.plot.x));
    this.lastBaseIndex = base;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    let ly = v.plot.h - 30;
    for (const it of this.items) {
      const mp = this.mapped(it, base);
      if (!mp) continue;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = v.i0; i <= v.i1; i++) {
        const y = mp.at(i);
        if (y === null) continue;
        const px = v.xOf(i);
        if (!started) ctx.moveTo(px, v.yOf(y));
        else ctx.lineTo(px, v.yOf(y));
        started = true;
      }
      ctx.stroke();
      const last = mp.pctAt(v.i1);
      ctx.font = v.font(11, 600);
      ctx.textAlign = 'left';
      ctx.fillStyle = it.color;
      ctx.fillText(
        `${it.label} ${last === null ? '' : `${last >= 0 ? '+' : ''}${last.toFixed(2)}%`}`,
        v.plot.x + 8,
        ly,
      );
      ly -= 16;
    }
    ctx.restore();
  }
}

/** Data-window rows of a cluster bar: delta, trades, bid / ask volume, time. */
export function barDataRows(b: Bar, formatVol: (v: number) => string = formatCompact): DataRow[] {
  const bid = b.sell;
  const ask = b.buy;
  return [
    { label: 'Delta', value: formatCompact(b.delta) },
    { label: 'Delta %', value: b.vol ? `${((b.delta / b.vol) * 100).toFixed(1)}%` : '0%' },
    { label: 'Trades', value: String(b.trades) },
    { label: 'Bid vol', value: formatVol(bid) },
    { label: 'Ask vol', value: formatVol(ask) },
    { label: 'Max Δ', value: formatCompact(b.maxDelta) },
    { label: 'Min Δ', value: formatCompact(b.minDelta) },
  ];
}
