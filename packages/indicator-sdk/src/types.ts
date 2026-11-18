import type { Bar, Trade } from '@htflow/market-data';
import type { ListOut, SeriesOut } from './buffers';
import type { DepthData, DerivativesData } from './feeds';

/** Appendix B categories (plus user scripts). */
export type IndicatorCategory =
  | 'volume-orderflow'
  | 'order-book'
  | 'options'
  | 'cot'
  | 'technical'
  | 'crypto'
  | 'trading'
  | 'samples'
  | 'custom';

export const CATEGORIES: { id: IndicatorCategory; label: string }[] = [
  { id: 'volume-orderflow', label: 'Volume & OrderFlow' },
  { id: 'order-book', label: 'Order Book' },
  { id: 'options', label: 'Options Analytics' },
  { id: 'cot', label: 'Commitments of Traders' },
  { id: 'technical', label: 'Technical' },
  { id: 'crypto', label: 'Crypto Metrics' },
  { id: 'trading', label: 'Trading' },
  { id: 'samples', label: 'Samples' },
  { id: 'custom', label: 'Custom (scripts)' },
];

export type PaneKind = 'overlay' | 'new';

/** Per-bar value sources (Appendix B common input). Prices are integer ticks. */
export type SourceId =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'hl2'
  | 'hlc3'
  | 'ohlc4'
  | 'volume'
  | 'delta'
  | 'cvd'
  | 'buy'
  | 'sell'
  | 'trades';

export const SOURCES: { value: SourceId; label: string; price: boolean }[] = [
  { value: 'open', label: 'Open', price: true },
  { value: 'high', label: 'High', price: true },
  { value: 'low', label: 'Low', price: true },
  { value: 'close', label: 'Close', price: true },
  { value: 'hl2', label: 'HL2 (H+L)/2', price: true },
  { value: 'hlc3', label: 'HLC3 (H+L+C)/3', price: true },
  { value: 'ohlc4', label: 'OHLC4 (O+H+L+C)/4', price: true },
  { value: 'volume', label: 'Volume', price: false },
  { value: 'delta', label: 'Delta (ask − bid)', price: false },
  { value: 'cvd', label: 'Cumulative delta', price: false },
  { value: 'buy', label: 'Buy volume (at ask)', price: false },
  { value: 'sell', label: 'Sell volume (at bid)', price: false },
  { value: 'trades', label: 'Trades count', price: false },
];

export function isPriceSource(s: SourceId): boolean {
  return SOURCES.find((x) => x.value === s)?.price ?? false;
}

export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** Period / timeframe values for 'timeframe' inputs. 'chart' = the chart's own bars. */
export type TimeframeId = 'chart' | 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D' | 'W' | 'MN';

export const TIMEFRAMES: { value: TimeframeId; label: string }[] = [
  { value: 'chart', label: 'Chart' },
  { value: 'M1', label: '1 minute' },
  { value: 'M5', label: '5 minutes' },
  { value: 'M15', label: '15 minutes' },
  { value: 'M30', label: '30 minutes' },
  { value: 'H1', label: '1 hour' },
  { value: 'H4', label: '4 hours' },
  { value: 'D', label: 'Day (session)' },
  { value: 'W', label: 'Week' },
  { value: 'MN', label: 'Month' },
];

// ------------------------------------------------------------------ inputs

interface InputCommon {
  label: string;
  /** Tooltip / help text (formula, meaning, units). */
  help?: string;
  /** Optional visual group in the Inputs tab. */
  group?: string;
}

export interface IntInput extends InputCommon {
  type: 'int';
  default: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}
export interface FloatInput extends InputCommon {
  type: 'float';
  default: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}
export interface BoolInput extends InputCommon {
  type: 'bool';
  default: boolean;
}
export interface EnumOption<T extends string = string> {
  value: T;
  label: string;
}
export interface EnumInput<T extends string = string> extends InputCommon {
  type: 'enum';
  default: T;
  options: readonly EnumOption<T>[];
}
export interface ColorInput extends InputCommon {
  type: 'color';
  default: string;
}
export interface LineStyleInput extends InputCommon {
  type: 'linestyle';
  default: LineStyle;
}
export interface SourceInput extends InputCommon {
  type: 'source';
  default: SourceId;
  /** Allowed sources (default: all). */
  sources?: readonly SourceId[];
}
export interface StringInput extends InputCommon {
  type: 'string';
  default: string;
  maxLength: number;
}
export interface TimeframeInput extends InputCommon {
  type: 'timeframe';
  default: TimeframeId;
  options?: readonly TimeframeId[];
}

export type InputDef =
  | IntInput
  | FloatInput
  | BoolInput
  | EnumInput
  | ColorInput
  | LineStyleInput
  | SourceInput
  | StringInput
  | TimeframeInput;

export type InputDefs = Record<string, InputDef>;
export type InputValue = number | boolean | string;
export type RawInputs = Record<string, InputValue>;

export type InputValueOf<D> = D extends IntInput | FloatInput
  ? number
  : D extends BoolInput
    ? boolean
    : D extends EnumInput<infer T>
      ? T
      : D extends SourceInput
        ? SourceId
        : D extends LineStyleInput
          ? LineStyle
          : D extends TimeframeInput
            ? TimeframeId
            : string;

export type InputValues<I extends InputDefs> = { readonly [K in keyof I]: InputValueOf<I[K]> };

// ------------------------------------------------------------------ outputs

/**
 * line/step/area/dots/histogram/band/bars are per-bar series stored in typed arrays;
 * markers/levels/zones are sparse lists (bubbles, labels, horizontal levels, boxes).
 */
export type OutputKind =
  | 'line'
  | 'step'
  | 'area'
  | 'histogram'
  | 'band'
  | 'dots'
  | 'bars'
  | 'markers'
  | 'levels'
  | 'zones';

export type SeriesKind = 'line' | 'step' | 'area' | 'histogram' | 'band' | 'dots' | 'bars';
export type ListKind = 'markers' | 'levels' | 'zones';

/** How values are formatted on scales and in the legend. 'price' values are in ticks. */
export type ValueUnit = 'price' | 'volume' | 'value' | 'percent' | 'count';

export interface OutputDef {
  kind: OutputKind;
  label: string;
  /** Primary colour (tone 0). */
  color: string;
  /** Secondary colour (tone 1), e.g. negative histogram bars, bearish cloud. */
  color2?: string;
  /** Tertiary colour (tone 2). */
  color3?: string;
  width?: number;
  style?: LineStyle;
  /** 0..1 */
  opacity?: number;
  visible?: boolean;
  /** Show the last value as a tag on the price / pane axis. */
  priceTag?: boolean;
  unit?: ValueUnit;
  /** Show this output's value in the legend (default true for series). */
  legend?: boolean;
  /** Histogram / area base value (default 0 in panes, bottom of the plot for overlays). */
  baseline?: number;
}

export type OutputDefs = Record<string, OutputDef>;

/** User-editable style of one output (Style tab). */
export interface OutputStyle {
  color: string;
  color2: string;
  color3: string;
  width: number;
  style: LineStyle;
  opacity: number;
  visible: boolean;
  label: string;
  priceTag: boolean;
}

export interface Marker {
  bar: number;
  value: number;
  shape: 'circle' | 'square' | 'triangleUp' | 'triangleDown' | 'diamond' | 'text';
  /** Radius in px (0 = default 3). */
  size: number;
  text?: string;
  tone: number;
  /** Where text goes relative to the shape. */
  textPos?: 'above' | 'below' | 'center' | 'right';
}

export interface Level {
  bar: number;
  /** Last bar index of the level (inclusive); -1 = extends to the right edge. */
  to: number;
  value: number;
  label?: string;
  tone: number;
}

export interface Zone {
  bar: number;
  /** Last bar index (inclusive); -1 = extends to the right edge. */
  to: number;
  top: number;
  bottom: number;
  tone: number;
  label?: string;
}

export type OutFor<D extends OutputDef> = D extends { kind: 'markers' }
  ? ListOut<Marker>
  : D extends { kind: 'levels' }
    ? ListOut<Level>
    : D extends { kind: 'zones' }
      ? ListOut<Zone>
      : SeriesOut;

export type Outputs<O extends OutputDefs> = { readonly [K in keyof O]: OutFor<O[K]> };

// ------------------------------------------------------------------ definition

/** Read-only market data an indicator is computed on. */
export interface BarData {
  bars: readonly Bar[];
  /** Changes whenever bars change (BarSeries.version). */
  version: number;
  tickSize: number;
  /** Trades in [from, to] ms — needed by tape-based indicators (Big Trades, Speed of Tape). */
  tradesBetween?(from: number, to: number): readonly Trade[];
  /** Funding / open interest / liquidation history (derivatives venues only). */
  derivatives?: DerivativesData;
  /** Resting-depth columns (store.depth) for order-book indicators. */
  depth?: DepthData;
}

export interface CalcContext<I extends InputDefs, O extends OutputDefs, S = undefined> {
  /** Bar being computed. calc() is called in increasing i; the last bar may be computed repeatedly. */
  i: number;
  bars: readonly Bar[];
  bar: Bar;
  /** bars.length */
  count: number;
  /** True when bar i is closed — this is its last calc until the next full recompute. */
  final: boolean;
  inputs: InputValues<I>;
  out: Outputs<O>;
  /** Persistent per-bar scratch series (NaN-initialised), e.g. running sums. Indices < i are stable. */
  buf(name: string): Float64Array;
  /** Source series materialised up to and including bar i. */
  src(id: SourceId): Float64Array;
  /** Trades of bar i (empty when the host has no tape). */
  trades(i: number): readonly Trade[];
  tickSize: number;
  /** Indicator state from init(); reset on every full recompute. Commit to it only when `final`. */
  state: S;
  /** Derivatives feed (undefined when the host has none). */
  derivatives: DerivativesData | undefined;
  /** Resting-depth columns (undefined when the host has none). */
  depth: DepthData | undefined;
  /** Shows a short note next to the legend title (e.g. "no data from this feed"); null clears it. */
  notice(text: string | null): void;
}

export interface IndicatorMeta {
  /** Stable id, persisted in workspaces (kebab-case). */
  id: string;
  name: string;
  /** Short legend prefix, e.g. "EMA". */
  short?: string;
  category: IndicatorCategory;
  /** Sub-group in the Technical category (Moving averages, Trend, …). */
  group?: string;
  pane: PaneKind;
  description: string;
  /** Formula / help text shown in the dialog. */
  formula?: string;
  /** Overlay: contribute to price auto-scale (default true). */
  autoscale?: boolean;
  /** Overlay default scale: 'merged' = price scale, 'own' = independent scale in the lower plot. */
  overlayScale?: 'own' | 'merged';
  /** Fixed pane value range, e.g. [0, 100] for RSI. */
  range?: [number, number];
  zeroLine?: boolean;
  /** Needs the tape (trades) — hosts without it show empty output. */
  needsTrades?: boolean;
  /**
   * Performance hint: list items (markers / levels / zones) are never edited after the calc that
   * added them, so the worker sends only items added from the recomputed bar on (default false:
   * every item is compared with what was sent, which also catches zones extended in place).
   */
  listsAppendOnly?: boolean;
  /**
   * Performance hint: calc() of bar i writes series values of bar i only (never earlier bars), so
   * the worker skips diffing the whole history after each tick. Leave unset when the indicator
   * revises the past (zigzag, displaced lines): the safe default diffs everything.
   */
  stableHistory?: boolean;
}

export interface IndicatorDefinition<
  I extends InputDefs = InputDefs,
  O extends OutputDefs = OutputDefs,
  S = undefined,
> extends IndicatorMeta {
  inputs: I;
  outputs: O;
  /** Legend title, e.g. "EMA 21 close". */
  title?(inputs: InputValues<I>): string;
  /** Horizontal guide lines in the pane (e.g. RSI 30/70). */
  guides?(inputs: InputValues<I>): number[];
  /** Creates the state object; called before every full recompute. */
  init?(inputs: InputValues<I>): S;
  calc(ctx: CalcContext<I, O, S>): void;
}

/** Type-erased definition used by registries and hosts. */
export type AnyIndicator = IndicatorDefinition<InputDefs, OutputDefs, unknown>;

export function defineIndicator<
  const I extends InputDefs,
  const O extends OutputDefs,
  S = undefined,
>(def: IndicatorDefinition<I, O, S>): IndicatorDefinition<I, O, S> {
  return def;
}

export function asAny<I extends InputDefs, O extends OutputDefs, S>(
  def: IndicatorDefinition<I, O, S>,
): AnyIndicator {
  return def as unknown as AnyIndicator;
}
