import type { Instrument } from '@htflow/market-data';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Palette handed to renderers (subset of ui-kit ThemeTokens, kept structural to avoid a React dep). */
export interface ChartPalette {
  chartBg: string;
  grid: string;
  border: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textSoft: string;
  surface2: string;
  surface3: string;
  up: string;
  down: string;
  warning: string;
  info: string;
  special: string;
  volume: string;
  cluster: string;
  clusterStrong: string;
  accent: string;
  accentText: string;
}

export interface PriceTag {
  px: number;
  bg: string;
  fg: string;
  text?: string;
  /** Second line under the price (bar countdown). */
  sub?: string;
}

/** Everything a layer needs to draw one frame. */
export interface ChartView {
  ctx: CanvasRenderingContext2D;
  palette: ChartPalette;
  instrument: Instrument;
  /** Whole canvas in CSS px. */
  width: number;
  height: number;
  /** Main price pane (excluding gutters and axes). */
  plot: Rect;
  /** Optional reserved column left of the plot (e.g. visible-range profile). */
  left: Rect;
  /** Optional reserved column right of the plot (e.g. DOM histogram). */
  right: Rect;
  /** Area below the main pane reserved by layers (statistics rows, volume pane). */
  bottom: Rect;
  priceAxis: Rect;
  timeAxis: Rect;
  /** First / last visible slot (inclusive, clamped to data). */
  i0: number;
  i1: number;
  slotCount: number;
  slotWidth: number;
  /** Pixels per tick. */
  tickPx: number;
  priceMin: number;
  priceMax: number;
  xOf(i: number): number;
  slotAt(x: number): number;
  yOf(px: number): number;
  pxAt(y: number): number;
  /** Crosshair position (CSS px) or null. */
  crosshair: { x: number; y: number; slot: number; px: number } | null;
  /** Layers push tags; the core draws them on the price axis. */
  tags: PriceTag[];
  font(size: number, weight?: number, mono?: boolean): string;
  /** Price scale mode of the main pane (log / percent / indexed …). */
  scaleMode?: import('./priceScale').PriceScaleMode;
  /** True when the price scale is inverted (high prices at the bottom). */
  inverted?: boolean;
  /** Base price (ticks) for percent / indexed labels: first visible value. */
  baseValue?: number;
  /** Time of slot i (epoch ms). */
  timeAt?(i: number): number;
}

/** One row of the data window (values at the cursor). */
export interface DataRow {
  label: string;
  value: string;
  color?: string;
}

export interface ChartLayer {
  readonly id: string;
  /** Price range (ticks) over slots [i0, i1] for auto-scale. */
  priceRange?(i0: number, i1: number): [number, number] | null;
  leftGutter?(): number;
  rightGutter?(): number;
  bottomHeight?(): number;
  /** Called when the user drags this sub-pane's separator; layers that persist their own height implement it. */
  setBottomHeight?(h: number): void;
  /** Label shown in pane menus (context-aware right-click). */
  paneLabel?: string;
  /** Rows for the data window at slot i (OHLCV, indicator values …). */
  dataWindow?(i: number): DataRow[];
  draw(v: ChartView): void;
  /** Called on click in the plot; return true when handled. */
  onClick?(v: ChartView, x: number, y: number, e: MouseEvent): boolean;
}

/** The x-axis data source: slots (bars, depth columns or prints) and their times. */
export interface SlotSource {
  count(): number;
  timeAt(i: number): number;
}
