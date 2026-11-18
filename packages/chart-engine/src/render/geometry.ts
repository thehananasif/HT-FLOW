import type { Bar } from '@htflow/market-data';
import type { Rect } from '../types';
import type { RectBatch } from './batch';
import { parseColor, type Rgba } from './color';

/**
 * Geometry builders (data → rect instances) shared by the Canvas2D and WebGL2 backends: both draw
 * exactly what these return, so the two paths cannot drift apart. Pure functions: everything they
 * need (scales, colours) comes in as arguments.
 */

/** x / y mapping of the frame (a subset of ChartView). */
export interface Layout {
  i0: number;
  i1: number;
  slotWidth: number;
  tickPx: number;
  xOf(i: number): number;
  yOf(px: number): number;
}

export interface CandleGeometryStyle {
  mode: 'candles' | 'bars' | 'transparent';
  /** Body width as a share of the slot (0..1). */
  bodyPct: number;
  /** Thin candle strip at the left of the slot (footprint). */
  strip: boolean;
  up: string;
  down: string;
  /** Border / wick colour when not the body colour. */
  borderColor: string;
  border: boolean;
  sameBorderAsBody: boolean;
  borderWidth: number;
  direction: 'close-open' | 'close-prev';
  barWidth: number;
  dojiColor: string;
  showOpen: boolean;
  showClose: boolean;
  wickUp?: string;
  wickDown?: string;
  borderUp?: string;
  borderDown?: string;
}

/** Body width in px for a slot width. */
export function candleBodyWidth(slotWidth: number, bodyPct: number, strip: boolean): number {
  return strip
    ? Math.min(8, Math.max(3, Math.floor(slotWidth * 0.08)))
    : Math.max(1, Math.floor(slotWidth * bodyPct));
}

/** Candles / OHLC bars / hollow candles of slots [i0, i1] as rects (wicks, ticks, bodies, borders). */
export function buildCandles(
  out: RectBatch,
  bars: readonly Bar[],
  L: Layout,
  st: CandleGeometryStyle,
): RectBatch {
  const sw = L.slotWidth;
  const bodyW = candleBodyWidth(sw, st.bodyPct, st.strip);
  const isBars = st.mode === 'bars';
  const last = Math.min(L.i1, bars.length - 1);
  for (let i = Math.max(0, L.i0); i <= last; i++) {
    const b = bars[i]!;
    const prev = i > 0 ? bars[i - 1] : undefined;
    const upDir = st.direction === 'close-prev' && prev ? b.c >= prev.c : b.c >= b.o;
    const doji = b.c === b.o && isBars && st.dojiColor;
    const col = doji ? st.dojiColor : upDir ? st.up : st.down;
    const up = !doji && upDir;
    const cx = st.strip ? L.xOf(i) - sw / 2 + bodyW / 2 + 1 : L.xOf(i);
    // Centre of the 1-px column the wick sits in (canvas strokes at x + 0.5).
    const xc = Math.round(cx) + 0.5;
    const wick = isBars ? '' : (up ? st.wickUp : st.wickDown) || '';
    const wickCol = wick || (st.sameBorderAsBody || isBars ? col : st.borderColor);
    const lw = isBars ? st.barWidth : 1;
    const yH = Math.round(L.yOf(b.h));
    const yL = Math.round(L.yOf(b.l));
    out.rect(xc - lw / 2, Math.min(yH, yL), lw, Math.abs(yL - yH), wickCol);
    if (isBars) {
      if (st.showOpen) {
        const yo = Math.round(L.yOf(b.o)) + 0.5;
        out.rect(xc - bodyW / 2, yo - lw / 2, bodyW / 2, lw, col);
      }
      if (st.showClose) {
        const yc = Math.round(L.yOf(b.c)) + 0.5;
        out.rect(xc, yc - lw / 2, bodyW / 2, lw, col);
      }
      continue;
    }
    // min / max keep body rects positive on inverted scales.
    const ya = L.yOf(b.o);
    const yb = L.yOf(b.c);
    const pad = st.strip ? L.tickPx / 2 : 0;
    const yTop = Math.round(Math.min(ya, yb) - pad);
    const yBot = Math.round(Math.max(ya, yb) + pad);
    const h = Math.max(1, yBot - yTop);
    const left = Math.round(cx - bodyW / 2);
    const dirBorder = (up ? st.borderUp : st.borderDown) || '';
    if (st.mode === 'transparent') {
      out.outline(left, yTop, bodyW, h + 1, dirBorder || col);
    } else {
      out.rect(left, yTop, bodyW, h, col);
      if ((st.border || dirBorder) && bodyW > 2)
        out.outline(
          left,
          yTop,
          bodyW,
          h + 1,
          dirBorder || (st.sameBorderAsBody ? col : st.borderColor),
          st.borderWidth,
        );
    }
  }
  return out;
}

/** Volume bars in a sub-pane rect, scaled to the visible maximum. */
export function buildVolumeBars(
  out: RectBatch,
  bars: readonly Bar[],
  L: Layout,
  pane: Rect,
  up: string,
  down: string,
  alpha: number,
): RectBatch {
  const last = Math.min(L.i1, bars.length - 1);
  let max = 0;
  for (let i = Math.max(0, L.i0); i <= last; i++) max = Math.max(max, bars[i]!.vol);
  if (max <= 0) return out;
  const w = Math.max(1, Math.floor(L.slotWidth * 0.6));
  const cu = parseColor(up);
  const cd = parseColor(down);
  for (let i = Math.max(0, L.i0); i <= last; i++) {
    const b = bars[i]!;
    const h = Math.max(1, (b.vol / max) * (pane.h - 6));
    out.rect(Math.round(L.xOf(i) - w / 2), pane.y + pane.h - h, w, h, b.c >= b.o ? cu : cd, alpha);
  }
  return out;
}

export interface ProfileRowsStyle {
  /** Left edge and full width of the largest row. */
  x0: number;
  maxW: number;
  rowTicks: number;
  /** Row height in px (already minus the 1-px gap). */
  rowH: number;
  pocRow: number;
  vah: number;
  val: number;
  poc: string;
  inside: string;
  outside: string;
  /** Rows outside [top, bottom] (y) are skipped. */
  top: number;
  bottom: number;
}

/** Volume-profile rows (price → volume) as horizontal bars, POC and value area coloured. */
export function buildProfileRows(
  out: RectBatch,
  rows: Iterable<[number, number]>,
  rowMax: number,
  L: Pick<Layout, 'yOf'>,
  st: ProfileRowsStyle,
): RectBatch {
  if (rowMax <= 0) return out;
  const cp: Rgba = parseColor(st.poc);
  const ci: Rgba = parseColor(st.inside);
  const co: Rgba = parseColor(st.outside);
  for (const [k, vol] of rows) {
    const y = L.yOf(k + st.rowTicks - 0.5);
    if (y > st.bottom || y + st.rowH < st.top) continue;
    const inVa = k >= st.val - st.rowTicks + 1 && k <= st.vah;
    out.rect(st.x0, y, (vol / rowMax) * st.maxW, st.rowH, k === st.pocRow ? cp : inVa ? ci : co);
  }
  return out;
}

/** Solid grid lines (crisp 1-px rows / columns) as rects. */
export function buildGridLines(
  out: RectBatch,
  plot: Rect,
  ys: readonly number[],
  xs: readonly number[],
  color: string,
  width: number,
): RectBatch {
  const c = parseColor(color);
  const w = Math.max(1, width);
  for (const y of ys) out.rect(plot.x, Math.round(y) + 0.5 - w / 2, plot.w, w, c);
  for (const x of xs) out.rect(Math.round(x) + 0.5 - w / 2, 0, w, plot.h, c);
  return out;
}

/** Vertical two-colour gradient approximated by `bands` horizontal rects (GL background). */
export function buildVerticalGradient(
  out: RectBatch,
  r: Rect,
  top: string,
  bottom: string,
  bands = 64,
): RectBatch {
  const a = parseColor(top);
  const b = parseColor(bottom);
  const n = Math.max(1, Math.min(bands, Math.ceil(r.h)));
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1);
    const y0 = r.y + (k * r.h) / n;
    const y1 = r.y + ((k + 1) * r.h) / n;
    out.rect(r.x, y0, r.w, y1 - y0, [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      a[3] + (b[3] - a[3]) * t,
    ]);
  }
  return out;
}
