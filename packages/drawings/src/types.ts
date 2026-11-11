/**
 * Drawing model (P12). Anchors are stored in time (epoch ms) + price (ticks, fractional allowed) —
 * never as slot indices — so drawings survive timeframe and bar-type changes.
 */

export interface Anchor {
  /** Epoch milliseconds. */
  t: number;
  /** Price in ticks (fractional allowed). */
  px: number;
}

export type Dash = 'solid' | 'dashed' | 'dotted';

export interface DrawingStyle {
  color: string;
  /** Line / text opacity 0..1. */
  opacity: number;
  /** Line width in px (1..8). */
  width: number;
  dash: Dash;
  /** Fill colour; '' = no fill. */
  fill: string;
  fillOpacity: number;
  text: string;
  fontSize: number;
}

export interface FibLevel {
  value: number;
  /** '' = drawing colour. */
  color: string;
  enabled: boolean;
}

export type ToolGroup =
  | 'lines'
  | 'shapes'
  | 'channels'
  | 'volume'
  | 'fib'
  | 'gann'
  | 'elliott'
  | 'markers'
  | 'text'
  | 'measure'
  | 'risk';

export type ToolId =
  // lines
  | 'trend-line'
  | 'trend-angle'
  | 'vertical-line'
  | 'horizontal-line'
  | 'horizontal-ray'
  | 'ray'
  | 'extended-line'
  | 'cross-line'
  | 'brush'
  | 'arrow'
  | 'polyline'
  // shapes
  | 'rectangle'
  | 'triangle'
  | 'ellipse'
  | 'circle'
  | 'arc'
  | 'highlight-y'
  | 'highlight-x'
  // channels & regression
  | 'parallel-channel'
  | 'regression-channel'
  | 'equidistant-channel'
  // volume analysis
  | 'volume-profile'
  | 'fixed-vp'
  | 'anchored-vp'
  | 'zigzag-vp'
  | 'anchored-vwap'
  | 'dynamic-poc'
  | 'cvd-correlation'
  // fibonacci
  | 'fib-retracement'
  | 'fib-extension'
  | 'fib-fan'
  | 'fib-time-zones'
  | 'fib-arcs'
  | 'fib-circles'
  | 'fib-channel'
  // gann & geometry
  | 'gann-fan'
  | 'gann-grid'
  | 'gann-box'
  | 'gann-square'
  | 'pitchfork'
  | 'schiff-pitchfork'
  | 'modified-schiff-pitchfork'
  // elliott & patterns
  | 'elliott-impulse'
  | 'elliott-correction'
  | 'elliott-triangle'
  | 'elliott-double'
  | 'elliott-triple'
  | 'abcd'
  | 'xabcd'
  | 'triangle-pattern'
  | 'head-shoulders'
  // markers
  | 'arrow-up'
  | 'arrow-down'
  | 'checkmark'
  | 'cross'
  | 'dot'
  | 'diamond'
  | 'square'
  | 'star'
  | 'flag'
  | 'emoji'
  // text
  | 'text'
  | 'anchored-text'
  | 'callout'
  | 'note'
  | 'price-note'
  | 'left-price-label'
  | 'right-price-label'
  // measurement
  | 'ruler'
  | 'measure'
  | 'date-range'
  | 'price-range'
  // risk
  | 'long-position'
  | 'short-position';

export type PropValue = number | string | boolean;

export interface Drawing {
  id: string;
  type: ToolId;
  anchors: Anchor[];
  style: DrawingStyle;
  locked: boolean;
  hidden: boolean;
  extendLeft: boolean;
  extendRight: boolean;
  showLabels: boolean;
  /** 'all' or a list of timeframe keys (specKey: 't60000', 'k500', …). */
  visibleOn: 'all' | string[];
  /** Stacking order; larger draws on top. */
  z: number;
  /** Mirror to every chart of the same instrument. */
  sync: boolean;
  /** Toast when the last price crosses the drawing (lines). */
  alert: boolean;
  /** Fibonacci / Gann levels. */
  levels?: FibLevel[];
  /** Tool-specific settings (qty, risk $, value area %, profile mode, σ bands…). */
  props: Record<string, PropValue>;
  createdAt: number;
}

export interface DrawingsDoc {
  v: 1;
  items: Drawing[];
}
