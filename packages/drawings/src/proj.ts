import { formatDateTime, type ChartView, type Rect } from '@htflow/chart-engine';
import { formatPrice, type Bar, type Instrument } from '@htflow/market-data';
import type { TimeAxis } from './timeAxis';

export interface ProjColors {
  up: string;
  down: string;
  text: string;
  textSecondary: string;
  bg: string;
  surface: string;
  warning: string;
  info: string;
}

/** Everything a tool needs to turn anchors into screen shapes for one frame. */
export interface Proj {
  /** time → x (CSS px). */
  x(t: number): number;
  /** price ticks → y. */
  y(px: number): number;
  /** x → time. */
  t(x: number): number;
  /** y → price ticks (fractional). */
  px(y: number): number;
  /** x → fractional slot. */
  slotAtX(x: number): number;
  xOfSlot(s: number): number;
  axis: TimeAxis;
  plot: Rect;
  slotWidth: number;
  /** Pixels per tick. */
  tickPx: number;
  /** Bars when the x scale is bar-based; null for depth-column charts. */
  bars: readonly Bar[] | null;
  barsVersion: number;
  inst: Instrument;
  colors: ProjColors;
  measure(text: string, size: number, weight?: number): number;
  fmtPrice(px: number): string;
  fmtTime(t: number): string;
}

export function makeProj(
  v: ChartView,
  axis: TimeAxis,
  bars: readonly Bar[] | null,
  barsVersion: number,
): Proj {
  const x0 = v.xOf(0);
  const sw = v.slotWidth;
  const ctx = v.ctx;
  const p = v.palette;
  return {
    x: (t) => v.xOf(axis.slotOf(t)),
    y: (px) => v.yOf(px),
    t: (x) => axis.timeOf((x - x0) / sw),
    px: (y) => v.pxAt(y),
    slotAtX: (x) => (x - x0) / sw,
    xOfSlot: (s) => v.xOf(s),
    axis,
    plot: v.plot,
    slotWidth: sw,
    tickPx: v.tickPx,
    bars,
    barsVersion,
    inst: v.instrument,
    colors: {
      up: p.up,
      down: p.down,
      text: p.textPrimary,
      textSecondary: p.textSecondary,
      bg: p.chartBg,
      surface: p.surface3,
      warning: p.warning,
      info: p.info,
    },
    measure: (text, size, weight = 400) => {
      ctx.font = v.font(size, weight);
      return ctx.measureText(text).width;
    },
    fmtPrice: (px) => formatPrice(Math.round(px), v.instrument),
    fmtTime: (t) => formatDateTime(t),
  };
}
