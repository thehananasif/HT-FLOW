import {
  buildProfile,
  formatCompact,
  formatPrice,
  type Bar,
  type BarSeries,
  type VolumeProfile,
} from '@htflow/market-data';
import type { ChartLayer, ChartView } from '../types';
import { clamp, rgba, rowTicksFor, sessionStart } from './util';

export type CandleMode = 'candles' | 'bars' | 'line' | 'area' | 'transparent' | 'hidden';

export function barsRange(bars: readonly Bar[], i0: number, i1: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = Math.max(0, i0); i <= i1 && i < bars.length; i++) {
    const b = bars[i]!;
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** Japanese candles / OHLC bars / line / area (P08 display modes). */
export class CandlesLayer implements ChartLayer {
  readonly id = 'candles';
  mode: CandleMode = 'candles';
  bodyPct = 0.6;
  /** Only draw a thin candle strip at the left of the slot (footprint). */
  strip = false;

  constructor(private series: () => BarSeries) {}

  priceRange(i0: number, i1: number) {
    return barsRange(this.series().bars, i0, i1);
  }

  draw(v: ChartView): void {
    if (this.mode === 'hidden') return;
    const { ctx, palette: p } = v;
    const bars = this.series().bars;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    if (this.mode === 'line' || this.mode === 'area') {
      ctx.beginPath();
      for (let i = v.i0; i <= v.i1; i++) {
        const b = bars[i]!;
        const x = v.xOf(i);
        if (i === v.i0) ctx.moveTo(x, v.yOf(b.c));
        else ctx.lineTo(x, v.yOf(b.c));
      }
      ctx.strokeStyle = p.info;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (this.mode === 'area' && v.i1 >= v.i0) {
        ctx.lineTo(v.xOf(v.i1), v.plot.h);
        ctx.lineTo(v.xOf(v.i0), v.plot.h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, v.plot.h);
        g.addColorStop(0, rgba(p.info, 0.35));
        g.addColorStop(1, rgba(p.info, 0));
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const sw = v.slotWidth;
    const bodyW = this.strip
      ? clamp(Math.floor(sw * 0.08), 3, 8)
      : Math.max(1, Math.floor(sw * this.bodyPct));
    for (let i = v.i0; i <= v.i1; i++) {
      const b = bars[i]!;
      const cx = this.strip ? v.xOf(i) - sw / 2 + bodyW / 2 + 1 : v.xOf(i);
      const up = b.c >= b.o;
      const col = up ? p.up : p.down;
      const x = Math.round(cx) + 0.5;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, Math.round(v.yOf(b.h)));
      ctx.lineTo(x, Math.round(v.yOf(b.l)));
      if (this.mode === 'bars') {
        ctx.moveTo(x - bodyW / 2, Math.round(v.yOf(b.o)) + 0.5);
        ctx.lineTo(x, Math.round(v.yOf(b.o)) + 0.5);
        ctx.moveTo(x, Math.round(v.yOf(b.c)) + 0.5);
        ctx.lineTo(x + bodyW / 2, Math.round(v.yOf(b.c)) + 0.5);
      }
      ctx.stroke();
      if (this.mode === 'bars') continue;
      const yTop = Math.round(v.yOf(Math.max(b.o, b.c)) - (this.strip ? v.tickPx / 2 : 0));
      const yBot = Math.round(v.yOf(Math.min(b.o, b.c)) + (this.strip ? v.tickPx / 2 : 0));
      const h = Math.max(1, yBot - yTop);
      const left = Math.round(cx - bodyW / 2);
      if (this.mode === 'transparent') {
        ctx.strokeRect(left + 0.5, yTop + 0.5, bodyW - 1, h);
      } else {
        ctx.fillStyle = col;
        ctx.fillRect(left, yTop, bodyW, h);
      }
    }
    ctx.restore();
  }
}

/** Volume bars in a bottom sub-pane (45% tint, direction coloured). */
export class VolumePaneLayer implements ChartLayer {
  readonly id = 'volume-pane';
  height = 80;
  constructor(private series: () => BarSeries) {}

  bottomHeight() {
    return this.height;
  }

  draw(v: ChartView): void {
    const { ctx, palette: p } = v;
    const r = v.bottom;
    const bars = this.series().bars;
    let max = 0;
    for (let i = v.i0; i <= v.i1; i++) max = Math.max(max, bars[i]!.vol);
    ctx.strokeStyle = p.divider;
    ctx.beginPath();
    ctx.moveTo(0, r.y + 0.5);
    ctx.lineTo(v.width, r.y + 0.5);
    ctx.stroke();
    if (max <= 0) return;
    const w = Math.max(1, Math.floor(v.slotWidth * 0.6));
    for (let i = v.i0; i <= v.i1; i++) {
      const b = bars[i]!;
      const h = Math.max(1, (b.vol / max) * (r.h - 6));
      ctx.fillStyle = rgba(b.c >= b.o ? p.up : p.down, 0.55);
      ctx.fillRect(Math.round(v.xOf(i) - w / 2), r.y + r.h - h, w, h);
    }
    ctx.fillStyle = p.textTertiary;
    ctx.font = v.font(10);
    ctx.textAlign = 'left';
    ctx.fillText(`Vol ${formatCompact(max)}`, r.x + 4, r.y + 9);
  }
}

/**
 * Session / period volume profiles drawn from each period's left edge, ≤ 72% of the period width,
 * with vPOC row highlighted and VAH / vPOC / VAL lines (P46 board 20).
 */
export class PeriodProfilesLayer implements ChartLayer {
  readonly id = 'period-profiles';
  periodMs = 3_600_000;
  widthPct = 0.72;
  valueAreaPct = 0.7;
  private cache = new Map<
    number,
    { n: number; version: number; prof: VolumeProfile; from: number; to: number }
  >();

  constructor(private series: () => BarSeries) {}

  draw(v: ChartView): void {
    const s = this.series();
    const bars = s.bars;
    if (!bars.length) return;
    const { ctx, palette: p } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    const rowTicks = rowTicksFor(v.tickPx, 2);
    let i = v.i0;
    while (i <= v.i1) {
      const key = Math.floor(bars[i]!.t / this.periodMs) * this.periodMs;
      let j = i;
      while (
        j + 1 < bars.length &&
        Math.floor(bars[j + 1]!.t / this.periodMs) * this.periodMs === key
      )
        j++;
      let from = i;
      while (from > 0 && Math.floor(bars[from - 1]!.t / this.periodMs) * this.periodMs === key)
        from--;
      const prof = this.profile(s, key, from, j);
      this.drawProfile(v, prof, from, j, rowTicks);
      i = j + 1;
    }
    ctx.restore();
    void p;
  }

  private profile(s: BarSeries, key: number, from: number, to: number): VolumeProfile {
    const c = this.cache.get(key);
    const live = to === s.bars.length - 1;
    if (c && c.from === from && c.to === to && (!live || c.version === s.version)) return c.prof;
    const prof = buildProfile(s.bars, from, to, this.valueAreaPct);
    this.cache.set(key, { n: to - from + 1, version: s.version, prof, from, to });
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value!);
    return prof;
  }

  private drawProfile(
    v: ChartView,
    prof: VolumeProfile,
    from: number,
    to: number,
    rowTicks: number,
  ): void {
    const { ctx, palette: p } = v;
    const x0 = v.xOf(from) - v.slotWidth / 2;
    const maxW = (to - from + 1) * v.slotWidth * this.widthPct;
    if (maxW < 4 || prof.maxVol <= 0) return;
    // Merge rows when ticks are tiny.
    const rows = new Map<number, number>();
    let rowMax = 0;
    for (const [px, l] of prof.levels) {
      const k = Math.floor(px / rowTicks) * rowTicks;
      const nv = (rows.get(k) ?? 0) + l.vol;
      rows.set(k, nv);
      if (nv > rowMax) rowMax = nv;
    }
    const h = Math.max(1, rowTicks * v.tickPx - (rowTicks * v.tickPx > 3 ? 1 : 0));
    const pocRow = Math.floor(prof.poc / rowTicks) * rowTicks;
    for (const [k, vol] of rows) {
      const y = v.yOf(k + rowTicks - 0.5);
      if (y > v.plot.h || y + h < 0) continue;
      const w = (vol / rowMax) * maxW;
      const inVa = k >= prof.val - rowTicks + 1 && k <= prof.vah;
      ctx.fillStyle =
        k === pocRow ? rgba(p.textSoft, 0.85) : rgba(p.clusterStrong, inVa ? 0.75 : 0.4);
      ctx.fillRect(x0, y, w, h);
    }
    const lines: [number, string][] = [
      [prof.vah, 'VAH'],
      [prof.poc, 'vPOC'],
      [prof.val, 'VAL'],
    ];
    ctx.font = v.font(9);
    ctx.textAlign = 'left';
    for (const [px, label] of lines) {
      const y = Math.round(v.yOf(px)) + 0.5;
      ctx.strokeStyle = label === 'vPOC' ? p.textSoft : p.textTertiary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + (to - from + 1) * v.slotWidth, y);
      ctx.stroke();
      if (maxW > 40) {
        ctx.fillStyle = p.textSecondary;
        ctx.fillText(label, x0 + (to - from + 1) * v.slotWidth - 24, y - 6);
      }
    }
  }
}

/** Last price line + direction-coloured axis tag; optional best bid/ask lines. */
export class LastPriceLayer implements ChartLayer {
  readonly id = 'last-price';
  showBidAsk = false;
  constructor(
    private last: () => { px: number; up: boolean } | null,
    private bidAsk: () => { bid: number; ask: number } | null = () => null,
  ) {}

  draw(v: ChartView): void {
    const l = this.last();
    const { ctx, palette: p } = v;
    if (this.showBidAsk) {
      const ba = this.bidAsk();
      if (ba) {
        for (const [px, col] of [
          [ba.bid, p.up],
          [ba.ask, p.down],
        ] as const) {
          const y = Math.round(v.yOf(px)) + 0.5;
          ctx.strokeStyle = rgba(col, 0.7);
          ctx.beginPath();
          ctx.moveTo(v.plot.x, y);
          ctx.lineTo(v.plot.x + v.plot.w, y);
          ctx.stroke();
        }
      }
    }
    if (!l) return;
    const col = l.up ? p.up : p.down;
    const y = Math.round(v.yOf(l.px)) + 0.5;
    ctx.strokeStyle = rgba(col, 0.8);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(v.plot.x, y);
    ctx.lineTo(v.plot.x + v.plot.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    v.tags.push({ px: l.px, bg: col, fg: '#000' });
  }
}

/** Two-line legend: symbol · venue · subtitle, then OHLCV of hovered (or last) bar. */
export class LegendLayer implements ChartLayer {
  readonly id = 'legend';
  constructor(
    private series: () => BarSeries | null,
    private title: () => string,
    private extra: () => string | null = () => null,
  ) {}

  draw(v: ChartView): void {
    const { ctx, palette: p } = v;
    const x = v.plot.x + 8;
    ctx.textAlign = 'left';
    ctx.font = v.font(11);
    ctx.fillStyle = p.textSecondary;
    ctx.fillText(this.title(), x, 12);
    const s = this.series();
    let y = 29;
    if (s && s.bars.length) {
      const idx =
        v.crosshair && v.crosshair.slot >= 0 && v.crosshair.slot < s.bars.length
          ? v.crosshair.slot
          : s.bars.length - 1;
      const b = s.bars[idx]!;
      const col = b.c >= b.o ? p.up : p.down;
      let cx = x;
      const part = (label: string, value: string, c: string) => {
        ctx.fillStyle = p.textSecondary;
        ctx.font = v.font(11);
        ctx.fillText(label, cx, y);
        cx += ctx.measureText(label).width + 3;
        ctx.fillStyle = c;
        ctx.font = v.font(11, 600);
        ctx.fillText(value, cx, y);
        cx += ctx.measureText(value).width + 8;
      };
      part('O', formatPrice(b.o, v.instrument), col);
      part('H', formatPrice(b.h, v.instrument), col);
      part('L', formatPrice(b.l, v.instrument), col);
      part('C', formatPrice(b.c, v.instrument), col);
      part('V', formatCompact(b.vol), p.textSoft);
      part('Δ', formatCompact(b.delta), b.delta >= 0 ? p.up : p.down);
      y += 17;
    }
    const e = this.extra();
    if (e) {
      ctx.font = v.font(10);
      ctx.fillStyle = p.textTertiary;
      ctx.fillText(e, x, y);
    }
  }
}

/** Dashed vertical session separators with "New session · dd Mon 00:00" labels (P31). */
export class SessionSeparatorLayer implements ChartLayer {
  readonly id = 'sessions';
  constructor(private series: () => BarSeries) {}

  draw(v: ChartView): void {
    const bars = this.series().bars;
    const { ctx, palette: p } = v;
    ctx.strokeStyle = p.textTertiary;
    ctx.setLineDash([5, 4]);
    ctx.font = v.font(10);
    ctx.textAlign = 'left';
    for (let i = Math.max(1, v.i0); i <= v.i1; i++) {
      if (sessionStart(bars[i]!.t) === sessionStart(bars[i - 1]!.t)) continue;
      const x = Math.round(v.xOf(i) - v.slotWidth / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, v.plot.h);
      ctx.stroke();
      const d = new Date(sessionStart(bars[i]!.t));
      ctx.fillStyle = p.textTertiary;
      ctx.fillText(`New session · ${d.toUTCString().slice(5, 11)} 00:00`, x + 4, v.plot.h - 10);
    }
    ctx.setLineDash([]);
  }
}

export type StatRowKey =
  'delta' | 'sessionDelta' | 'volume' | 'trades' | 'deltaPct' | 'maxDelta' | 'minDelta';

const STAT_LABELS: Record<StatRowKey, string> = {
  delta: 'Delta',
  sessionDelta: 'Session Delta',
  volume: 'Volume',
  trades: 'Trades',
  deltaPct: 'Delta %',
  maxDelta: 'Max delta',
  minDelta: 'Min delta',
};

/** Cluster statistics rows under the chart (P10/P46): each row toggleable and colour-graded. */
export class StatsRowsLayer implements ChartLayer {
  readonly id = 'stats-rows';
  rows: StatRowKey[] = ['delta', 'sessionDelta', 'volume'];
  rowHeight = 23;
  labelWidth = 98;
  /** 'footprint' = text cells with tints; 'heat' = coloured cells (Order Flow). */
  style: 'footprint' | 'heat' = 'footprint';
  private cum: { version: number; values: Float64Array } = {
    version: -1,
    values: new Float64Array(0),
  };

  constructor(private series: () => BarSeries) {}

  bottomHeight() {
    return this.rows.length * this.rowHeight + 2;
  }

  private sessionDeltas(s: BarSeries): Float64Array {
    if (this.cum.version === s.version && this.cum.values.length === s.bars.length)
      return this.cum.values;
    const out = new Float64Array(s.bars.length);
    let acc = 0;
    for (let i = 0; i < s.bars.length; i++) {
      const b = s.bars[i]!;
      if (i > 0 && sessionStart(b.t) !== sessionStart(s.bars[i - 1]!.t)) acc = 0;
      acc += b.delta;
      out[i] = acc;
    }
    this.cum = { version: s.version, values: out };
    return out;
  }

  private value(key: StatRowKey, b: Bar, i: number, sd: Float64Array): number {
    switch (key) {
      case 'delta':
        return b.delta;
      case 'sessionDelta':
        return sd[i] ?? 0;
      case 'volume':
        return b.vol;
      case 'trades':
        return b.trades;
      case 'deltaPct':
        return b.vol ? (b.delta / b.vol) * 100 : 0;
      case 'maxDelta':
        return b.maxDelta;
      case 'minDelta':
        return b.minDelta;
    }
  }

  draw(v: ChartView): void {
    const s = this.series();
    const bars = s.bars;
    const { ctx, palette: p } = v;
    const sd = this.sessionDeltas(s);
    const top = v.bottom.y + 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, v.bottom.y, v.plot.x + v.plot.w, v.bottom.h);
    ctx.clip();
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(0, v.bottom.y, v.plot.x + v.plot.w, v.bottom.h);
    this.rows.forEach((key, r) => {
      const y = top + r * this.rowHeight;
      let max = 1e-9;
      for (let i = v.i0; i <= v.i1; i++)
        max = Math.max(max, Math.abs(this.value(key, bars[i]!, i, sd)));
      const cw = v.slotWidth - (v.slotWidth > 6 ? 2 : 0);
      for (let i = v.i0; i <= v.i1; i++) {
        const val = this.value(key, bars[i]!, i, sd);
        const x = v.xOf(i) - v.slotWidth / 2 + 1;
        const k = Math.min(1, Math.abs(val) / max);
        let bg: string;
        if (key === 'volume') bg = rgba(p.textSoft, this.style === 'heat' ? 0.08 + k * 0.3 : 0.04);
        else if (key === 'sessionDelta' && this.style === 'footprint')
          bg = rgba(p.info, 0.25 + k * 0.5);
        else bg = rgba(val >= 0 ? p.up : p.down, 0.12 + k * (this.style === 'heat' ? 0.65 : 0.4));
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cw, this.rowHeight - 1);
        if (v.slotWidth >= 34) {
          ctx.fillStyle = p.textPrimary;
          ctx.font = v.font(11);
          ctx.textAlign = 'left';
          ctx.fillText(
            key === 'deltaPct' ? val.toFixed(1) : formatCompact(Math.round(val * 1000) / 1000),
            x + 6,
            y + this.rowHeight / 2,
          );
        }
      }
      // Label column.
      const lw = v.left.w > 0 ? v.left.w : this.labelWidth;
      ctx.fillStyle = p.surface2;
      ctx.fillRect(0, y, lw, this.rowHeight - 1);
      ctx.fillStyle = p.textSoft;
      ctx.font = v.font(11);
      ctx.textAlign = 'left';
      ctx.fillText(STAT_LABELS[key], 6, y + this.rowHeight / 2);
    });
    ctx.restore();
  }
}
