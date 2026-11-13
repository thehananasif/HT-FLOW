import { barsRange, type ChartLayer, type ChartView } from '@htflow/chart-engine';
import { formatCompact, type BarSeries, type OrderBook } from '@htflow/market-data';
import { footprintMode, type FootprintModeDef } from './modes';
import {
  absorptionRows,
  imbalances,
  mergeRows,
  passesFilter,
  stackedZones,
  valueAreaRows,
  type ImbalanceDirection,
  type Row,
} from './merge';

export interface FootprintSettings {
  mode: string;
  /** 'auto' or fixed ticks per row. */
  ticksPerRow: 'auto' | number;
  /** Below this slot width the footprint collapses to candles (Chart settings: "Candle width to auto transform"). */
  autoCandleWidth: number;
  showPoc: boolean;
  imbalance: {
    enabled: boolean;
    ratio: number;
    minVolume: number;
    stacked: number;
    /** Diagonal (ask vs bid one row lower) or horizontal (ask vs bid on the same row). */
    direction?: ImbalanceDirection;
  };
  /** Hide values below this. */
  hideBelow: number;
  /** Cell filters: rows under this volume / |delta| are not drawn. */
  filters?: { minVolume: number; minDelta: number };
  /** Value area per bar: shading of the rows holding `pct` (0..1) of the bar volume. */
  valueArea?: { show: boolean; pct: number; color: string };
  /** Element colours ('' = theme). Bid / ask / text colours come through the palette override. */
  colors?: { poc: string; imbBuy: string; imbSell: string };
  /** What the plain cell background follows, and its strength (0..1). */
  colorMode?: 'volume' | 'delta' | 'none';
  cellOpacity?: number;
  /** Largest cell font (auto-fit shrinks below it; fixed when autoFont is false). */
  fontSize?: number;
  autoFont?: boolean;
  /** Bars collapse to candles when a price row would be thinner than this (px). */
  minCellHeight?: number;
  /** Mark absorption rows (heavy volume at the bar's high / low). */
  absorption?: boolean;
}

export const DEFAULT_FOOTPRINT: FootprintSettings = {
  mode: 'volume',
  ticksPerRow: 'auto',
  autoCandleWidth: 20,
  showPoc: true,
  imbalance: { enabled: true, ratio: 3, minVolume: 0, stacked: 3, direction: 'diagonal' },
  hideBelow: 0,
  filters: { minVolume: 0, minDelta: 0 },
  valueArea: { show: false, pct: 0.7, color: '' },
  colors: { poc: '', imbBuy: '', imbSell: '' },
  colorMode: 'volume',
  cellOpacity: 1,
  fontSize: 12,
  autoFont: true,
  minCellHeight: 9,
  absorption: false,
};

/** Font size of footprint cell text for a row height (auto-fit capped at `max`, or fixed). */
export function cellFontSize(rowH: number, max = 12, auto = true): number {
  return auto ? Math.max(8, Math.min(max, Math.floor(rowH - 3))) : max;
}

const ROW_STEPS = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

export function autoRowTicks(tickPx: number, minPx = 13): number {
  for (const s of ROW_STEPS) if (s * tickPx >= minPx) return s;
  return 10000;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Footprint / cluster renderer (P10, P46 board 21). */
export class FootprintLayer implements ChartLayer {
  readonly id = 'footprint';
  settings: FootprintSettings;
  /** Rows used in the last frame (shared with gutters). */
  rowTicks = 1;

  constructor(
    private series: () => BarSeries,
    settings: Partial<FootprintSettings> = {},
  ) {
    this.settings = { ...DEFAULT_FOOTPRINT, ...settings };
  }

  get mode(): FootprintModeDef {
    return footprintMode(this.settings.mode);
  }

  /** Ticks per row for a view (auto picks the smallest step that keeps rows ≥ min cell height). */
  rowTicksFor(v: ChartView): number {
    const s = this.settings;
    const minH = Math.max(1, s.minCellHeight ?? 9);
    return s.ticksPerRow === 'auto' ? autoRowTicks(v.tickPx, Math.max(13, minH)) : s.ticksPerRow;
  }

  collapsed(v: ChartView): boolean {
    if (v.slotWidth < this.settings.autoCandleWidth) return true;
    return this.rowTicksFor(v) * v.tickPx < (this.settings.minCellHeight ?? 0);
  }

  priceRange(i0: number, i1: number) {
    return barsRange(this.series().bars, i0, i1);
  }

  draw(v: ChartView): void {
    const s = this.settings;
    this.rowTicks = this.rowTicksFor(v);
    if (this.collapsed(v)) return;
    const bars = this.series().bars;
    const { ctx, palette: p } = v;
    const mode = this.mode;
    const rt = this.rowTicks;
    const rowH = rt * v.tickPx;
    const stripW = Math.min(8, Math.max(3, Math.floor(v.slotWidth * 0.08)));
    const cellW = v.slotWidth - stripW - 4;
    const showText = rowH >= 9 && cellW >= 22;
    const fontSize = cellFontSize(rowH, s.fontSize ?? 12, s.autoFont !== false);
    const filt = s.filters ?? { minVolume: 0, minDelta: 0 };
    const va = s.valueArea;
    const col = s.colors ?? { poc: '', imbBuy: '', imbSell: '' };
    const imbBuy = col.imbBuy || p.up;
    const imbSell = col.imbSell || p.down;

    // Visible max for colour grading.
    let maxV = 1e-9;
    let maxD = 1e-9;
    let maxSide = 1e-9;
    const rowsCache: Row[][] = [];
    for (let i = v.i0; i <= v.i1; i++) {
      const rows = mergeRows(bars[i]!, rt);
      rowsCache.push(rows);
      for (const r of rows) {
        const val = mode.content === 'trades' ? r.trades : r.vol;
        if (val > maxV) maxV = val;
        if (Math.abs(r.delta) > maxD) maxD = Math.abs(r.delta);
        if (r.bid > maxSide) maxSide = r.bid;
        if (r.ask > maxSide) maxSide = r.ask;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.textBaseline = 'middle';
    ctx.font = v.font(fontSize);

    for (let i = v.i0; i <= v.i1; i++) {
      const rows = rowsCache[i - v.i0]!;
      if (!rows.length) continue;
      const x = v.xOf(i) - v.slotWidth / 2 + stripW + 3;
      let pocIdx = 0;
      for (let k = 1; k < rows.length; k++) if (rows[k]!.vol > rows[pocIdx]!.vol) pocIdx = k;
      const imb =
        s.imbalance.enabled && (mode.content === 'bidask' || mode.content === 'delta')
          ? imbalances(
              rows,
              s.imbalance.direction ?? 'diagonal',
              s.imbalance.ratio,
              s.imbalance.minVolume,
            )
          : null;

      if (imb && s.imbalance.stacked > 1) {
        for (const [lo, hi, side] of stackedZones(rows, imb, s.imbalance.stacked)) {
          const y0 = v.yOf(hi + rt - 0.5);
          const y1 = v.yOf(lo - 0.5);
          ctx.fillStyle = rgba(side === 'buy' ? imbBuy : imbSell, 0.12);
          ctx.fillRect(x + cellW, y0, v.plot.x + v.plot.w - x - cellW, y1 - y0);
        }
      }

      // Value area per bar: tinted block behind the cells + a bracket at the left edge.
      const vaRows = va?.show ? valueAreaRows(rows, va.pct) : null;
      if (vaRows) {
        const yHi = v.yOf(rows[vaRows.hi]!.px + rt - 0.5);
        const yLo = v.yOf(rows[vaRows.lo]!.px - 0.5);
        const vc = va!.color || p.info;
        ctx.fillStyle = rgba(vc, 0.16);
        ctx.fillRect(x - 2, Math.min(yHi, yLo), cellW + 2, Math.abs(yLo - yHi));
        ctx.fillStyle = vc;
        ctx.fillRect(x - 2, Math.min(yHi, yLo), 2, Math.abs(yLo - yHi));
      }
      const absorb = s.absorption ? new Set(absorptionRows(rows)) : null;

      for (let k = 0; k < rows.length; k++) {
        const r = rows[k]!;
        const yTop = v.yOf(r.px + rt - 0.5);
        const h = Math.max(1, rowH - (rowH > 4 ? 1 : 0));
        if (yTop > v.plot.h || yTop + h < 0) continue;
        const val = mode.content === 'trades' ? r.trades : r.vol;
        if (val < s.hideBelow) continue;
        if (!passesFilter(r, filt.minVolume, filt.minDelta)) continue;
        const kv = val / maxV;
        const dShare = r.vol ? r.delta / r.vol : 0;
        this.drawCell(v, mode, r, x, yTop, cellW, h, kv, dShare, maxV, maxD, maxSide);
        if (absorb?.has(k)) {
          ctx.fillStyle = p.warning;
          ctx.beginPath();
          ctx.arc(x + cellW - 4, yTop + h / 2, Math.min(3, h / 3), 0, Math.PI * 2);
          ctx.fill();
        }
        if (s.showPoc && k === pocIdx) {
          ctx.strokeStyle = col.poc || p.textPrimary;
          ctx.lineWidth = 1;
          ctx.strokeRect(
            Math.round(x) + 0.5,
            Math.round(yTop) + 0.5,
            Math.round(cellW) - 1,
            Math.round(h) - 1,
          );
        }
        if (showText) {
          this.drawText(v, mode, r, x, yTop + h / 2, cellW, k === pocIdx, imb?.[k], fontSize);
        }
      }
    }
    ctx.restore();
  }

  private drawCell(
    v: ChartView,
    mode: FootprintModeDef,
    r: Row,
    x: number,
    y: number,
    w: number,
    h: number,
    kv: number,
    dShare: number,
    maxV: number,
    maxD: number,
    maxSide: number,
  ): void {
    const { ctx, palette: p } = v;
    const st = mode.style;
    const op = Math.max(0, Math.min(1, this.settings.cellOpacity ?? 1));
    const cm = this.settings.colorMode ?? 'volume';
    const base = rgba(p.clusterStrong, (0.18 + kv * 0.55) * op);
    const deltaCol = rgba(
      dShare >= 0 ? p.up : p.down,
      (0.15 + Math.min(1, Math.abs(dShare)) * 0.6 * (0.4 + kv * 0.6)) * op,
    );
    switch (st) {
      case 'plain':
        if (cm === 'none') {
          ctx.fillStyle = rgba(p.surface3, 0.5 * op);
        } else if (cm === 'delta') {
          ctx.fillStyle = deltaCol;
        } else if (mode.content === 'bidask') {
          ctx.fillStyle = rgba(p.surface3, 0.9 * op);
        } else {
          ctx.fillStyle = base;
        }
        ctx.fillRect(x, y, w, h);
        return;
      case 'deltaColored':
        ctx.fillStyle =
          mode.content === 'delta'
            ? rgba(r.delta >= 0 ? p.up : p.down, 0.12 + (Math.abs(r.delta) / maxD) * 0.7)
            : deltaCol;
        ctx.fillRect(x, y, w, h);
        return;
      case 'histogram':
      case 'digital':
      case 'deltaHistogram': {
        ctx.fillStyle = rgba(p.surface3, 0.6);
        ctx.fillRect(x, y, w, h);
        const col = st === 'deltaHistogram' ? (dShare >= 0 ? p.up : p.down) : p.clusterStrong;
        ctx.fillStyle = rgba(col, st === 'digital' ? 0.9 : 0.7);
        const bw = Math.max(1, kv * w);
        if (mode.content === 'bidask') {
          const half = w / 2;
          ctx.fillStyle = rgba(p.down, 0.6);
          ctx.fillRect(x + half - (r.bid / maxSide) * half, y, (r.bid / maxSide) * half, h);
          ctx.fillStyle = rgba(p.up, 0.6);
          ctx.fillRect(x + half, y, (r.ask / maxSide) * half, h);
        } else ctx.fillRect(x, y, bw, h);
        return;
      }
      case 'ladder': {
        const half = w / 2;
        ctx.fillStyle = rgba(p.down, 0.12 + (r.bid / maxSide) * 0.55);
        ctx.fillRect(x, y, half - 1, h);
        ctx.fillStyle = rgba(p.up, 0.12 + (r.ask / maxSide) * 0.55);
        ctx.fillRect(x + half, y, half, h);
        return;
      }
      case 'profile': {
        const half = w / 2;
        ctx.fillStyle = rgba(p.down, 0.65);
        ctx.fillRect(x + half - (r.bid / maxSide) * half, y, (r.bid / maxSide) * half, h);
        ctx.fillStyle = rgba(p.up, 0.65);
        ctx.fillRect(x + half, y, (r.ask / maxSide) * half, h);
        return;
      }
      case 'deltaProfile': {
        const half = w / 2;
        const len = (Math.abs(r.delta) / maxD) * half;
        ctx.fillStyle = rgba(r.delta >= 0 ? p.up : p.down, 0.7);
        if (r.delta >= 0) ctx.fillRect(x + half, y, len, h);
        else ctx.fillRect(x + half - len, y, len, h);
        ctx.fillStyle = p.divider;
        ctx.fillRect(x + half, y, 1, h);
        void maxV;
        return;
      }
    }
  }

  private drawText(
    v: ChartView,
    mode: FootprintModeDef,
    r: Row,
    x: number,
    y: number,
    w: number,
    poc: boolean,
    imb: { buy: boolean; sell: boolean } | undefined,
    fontSize: number,
  ): void {
    const { ctx, palette: p } = v;
    const fmt = (n: number) => formatCompact(Math.round(n * 1000) / 1000);
    ctx.font = v.font(fontSize, poc ? 700 : 400);
    ctx.fillStyle = p.textPrimary;
    switch (mode.content) {
      case 'bidask': {
        const half = w / 2;
        ctx.textAlign = 'right';
        ctx.fillStyle = imb?.sell ? this.settings.colors?.imbSell || p.down : p.textSoft;
        if (imb?.sell) ctx.font = v.font(fontSize, 700);
        ctx.fillText(fmt(r.bid), x + half - 6, y);
        ctx.font = v.font(fontSize, poc ? 700 : 400);
        ctx.textAlign = 'center';
        ctx.fillStyle = p.textTertiary;
        if (mode.style === 'plain' || mode.style === 'deltaColored') ctx.fillText('x', x + half, y);
        ctx.textAlign = 'left';
        ctx.fillStyle = imb?.buy ? this.settings.colors?.imbBuy || p.up : p.textSoft;
        if (imb?.buy) ctx.font = v.font(fontSize, 700);
        ctx.fillText(fmt(r.ask), x + half + 6, y);
        return;
      }
      case 'voltrade':
        ctx.textAlign = 'left';
        ctx.fillText(`${fmt(r.vol)} x ${r.trades}`, x + 5, y);
        return;
      case 'voldelta':
        ctx.textAlign = 'left';
        ctx.fillText(fmt(r.vol), x + 5, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = r.delta >= 0 ? p.up : p.down;
        ctx.fillText(fmt(r.delta), x + w - 5, y);
        return;
      case 'delta':
        ctx.textAlign = mode.style === 'deltaProfile' ? (r.delta >= 0 ? 'left' : 'right') : 'left';
        ctx.fillStyle = mode.style === 'deltaProfile' ? p.textSoft : p.textPrimary;
        ctx.fillText(
          fmt(r.delta),
          mode.style === 'deltaProfile' ? (r.delta >= 0 ? x + w / 2 + 4 : x + w / 2 - 4) : x + 5,
          y,
        );
        return;
      case 'trades':
        ctx.textAlign = 'left';
        ctx.fillText(String(r.trades), x + 5, y);
        return;
      case 'volume':
        ctx.textAlign = 'left';
        ctx.fillText(fmt(r.vol), x + 5, y);
        return;
    }
  }
}

/** Left gutter: visible-range volume profile with numbers, vPOC and sell/buy/total pills. */
export class VisibleProfileGutter implements ChartLayer {
  readonly id = 'visible-profile';
  width = 130;
  constructor(
    private series: () => BarSeries,
    private rowTicks: () => number,
  ) {}

  leftGutter() {
    return this.width;
  }

  draw(v: ChartView): void {
    const bars = this.series().bars;
    const rt = this.rowTicks();
    const { ctx, palette: p } = v;
    const r = v.left;
    ctx.fillStyle = p.surface2;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const rows = new Map<number, number>();
    let buy = 0;
    let sell = 0;
    for (let i = v.i0; i <= v.i1; i++) {
      for (const [px, c] of bars[i]!.clusters) {
        const k = Math.floor(px / rt) * rt;
        rows.set(k, (rows.get(k) ?? 0) + c.bid + c.ask);
        buy += c.ask;
        sell += c.bid;
      }
    }
    let max = 0;
    let poc = Number.NaN;
    for (const [k, vol] of rows) {
      if (vol > max) {
        max = vol;
        poc = k;
      }
    }
    const rowH = rt * v.tickPx;
    const h = Math.max(1, rowH - (rowH > 4 ? 1 : 0));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h - 20);
    ctx.clip();
    const fs = Math.max(8, Math.min(12, Math.floor(rowH - 3)));
    for (const [k, vol] of rows) {
      const y = v.yOf(k + rt - 0.5);
      if (y > r.h || y + h < 0) continue;
      const w = Math.max(1, (vol / max) * (r.w - 4));
      const isPoc = k === poc;
      ctx.fillStyle = isPoc ? rgba(p.textSoft, 0.75) : rgba(p.clusterStrong, 0.85);
      ctx.fillRect(r.x, y, w, h);
      if (rowH >= 9) {
        ctx.font = v.font(fs, isPoc ? 700 : 400);
        ctx.fillStyle = isPoc ? '#000' : p.textPrimary;
        ctx.textAlign = 'left';
        ctx.fillText(formatCompact(Math.round(vol * 1000) / 1000), r.x + 4, y + h / 2);
        if (isPoc) {
          ctx.textAlign = 'right';
          ctx.font = v.font(10);
          ctx.fillText('vPOC', r.x + r.w - 6, y + h / 2);
        }
      }
    }
    ctx.restore();
    // Totals pills (sell / buy / total).
    const y = r.h - 18;
    const w3 = (r.w - 4) / 3;
    const pills: [number, string, string][] = [
      [sell, p.down, '#fff'],
      [buy, p.up, '#000'],
      [buy + sell, p.surface3, p.textPrimary],
    ];
    ctx.font = v.font(10, 600);
    ctx.textAlign = 'center';
    pills.forEach(([val, bg, fg], i) => {
      ctx.fillStyle = bg;
      ctx.fillRect(r.x + 2 + i * w3, y, w3 - 2, 16);
      ctx.fillStyle = fg;
      ctx.fillText(formatCompact(Math.round(val)), r.x + 2 + i * w3 + w3 / 2, y + 8);
    });
  }
}

/** Right gutter: DOM histogram (ask red above price, bid green below) with sizes. */
export class DomHistogramGutter implements ChartLayer {
  readonly id = 'dom-histogram';
  width = 116;
  constructor(
    private book: () => OrderBook,
    private rowTicks: () => number,
  ) {}

  rightGutter() {
    return this.width;
  }

  draw(v: ChartView): void {
    const b = this.book();
    const rt = this.rowTicks();
    const { ctx, palette: p } = v;
    const r = v.right;
    ctx.fillStyle = p.chartBg;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (Number.isNaN(b.bestBid)) return;
    const rows = new Map<number, { q: number; ask: boolean }>();
    const lo = Math.floor(v.priceMin / rt) * rt;
    const hi = Math.ceil(v.priceMax);
    for (const [px, q] of b.asks) {
      if (px < lo || px > hi) continue;
      const k = Math.floor(px / rt) * rt;
      const e = rows.get(k) ?? { q: 0, ask: true };
      e.q += q;
      rows.set(k, e);
    }
    for (const [px, q] of b.bids) {
      if (px < lo || px > hi) continue;
      const k = Math.floor(px / rt) * rt;
      const e = rows.get(k) ?? { q: 0, ask: false };
      e.q += q;
      rows.set(k, e);
    }
    let max = 0;
    for (const e of rows.values()) max = Math.max(max, e.q);
    const rowH = rt * v.tickPx;
    const h = Math.max(1, rowH - (rowH > 4 ? 2 : 0));
    const textW = 26;
    const barMax = r.w - textW - 6;
    const fs = Math.max(8, Math.min(11, Math.floor(rowH - 3)));
    for (const [k, e] of rows) {
      const y = v.yOf(k + rt - 0.5);
      const w = Math.max(1, (e.q / max) * barMax);
      ctx.fillStyle = rgba(e.ask ? p.down : p.up, 0.8);
      ctx.fillRect(r.x + 4 + barMax - w, y + (rowH > 4 ? 1 : 0), w, h);
      if (rowH >= 9) {
        ctx.fillStyle = p.textSoft;
        ctx.font = v.font(fs);
        ctx.textAlign = 'left';
        ctx.fillText(formatCompact(Math.round(e.q * 1000) / 1000), r.x + barMax + 8, y + rowH / 2);
      }
    }
  }
}
