import type { InputDefs, InputValues, RawInputs, TimeframeId } from '@htflow/indicator-sdk';
import type { Bar, BarSpec, OrderBook, Side, Trade } from '@htflow/market-data';
import type { Fill, Order, OrderType } from '@htflow/trading';

/** Economics of the traded instrument (prices are integer ticks everywhere). */
export interface StrategyInstrument {
  id: string;
  symbol: string;
  tickSize: number;
  /** Currency per tick per contract; 0 = linear (PnL = ticks × tickSize × qty). */
  tickValue: number;
  pricePrecision: number;
}

export type StrategyCategory =
  'reversal' | 'continuation' | 'mean-reversion' | 'breakout' | 'custom';

/** Bracket attached to an entry (P42 SDK `{stopTicks, targetTicks, trailing}`). */
export interface BracketOpts {
  /** Stop-loss distance from the average fill, in ticks. */
  stopTicks?: number;
  /** One or more targets in ticks (quantity is split evenly). */
  targetTicks?: number | number[];
  /** Trailing stop: once filled, the stop follows the best price at this distance (ticks). */
  trailTicks?: number;
}

export interface OrderOpts {
  bracket?: BracketOpts;
  /** Free text shown in the trades list (e.g. the signal name). */
  label?: string;
  /**
   * ATM template id (packages/trading atm.ts), resolved through `RunnerHost.atm` at the order's
   * price with the bars' ATR. Replaces `bracket` when the template resolves.
   */
  atm?: string;
}

/** A read-only view of an order the strategy placed. */
export interface OrderHandle {
  readonly id: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: number;
  readonly status: Order['status'];
  readonly filled: number;
}

export interface StrategyPosition {
  /** Signed quantity: > 0 long, < 0 short. */
  qty: number;
  /** Average entry price in ticks (0 when flat). */
  avgPx: number;
  side: 'long' | 'short' | 'flat';
  /** Unrealised P&L at the last trade, in account currency. */
  openPnl: number;
}

/** Result of one indicator, recomputed incrementally as bars arrive. */
export interface IndicatorHandle {
  /** Output value `barsAgo` bars before `ctx.index` (default: first output, 0 bars ago). NaN when absent. */
  value(output?: string, barsAgo?: number): number;
  /** Output value at an absolute bar index. */
  at(output: string, index: number): number;
}

export interface Imbalance {
  px: number;
  side: 'buy' | 'sell';
  ratio: number;
}

export interface ImbalanceOpts {
  /** ask[p] ≥ ratio · bid[p−1] (buy) / bid[p] ≥ ratio · ask[p+1] (sell). Default 3. */
  ratio?: number;
  /** Minimum volume on the dominant side. Default 1. */
  minVolume?: number;
}

/** Everything a hook sees. `ctx.state` is the object returned by `init`. */
export interface StrategyContext<I extends InputDefs = InputDefs, S = unknown> {
  readonly inputs: InputValues<I>;
  readonly instrument: StrategyInstrument;
  /** All bars so far (the last one may still be forming). */
  readonly bars: readonly Bar[];
  /** onBar: the bar that just closed. onTrade / onBook: the forming bar. */
  readonly bar: Bar;
  readonly index: number;
  /** Strategy clock (trade time in backtests, exchange time live), epoch ms. */
  readonly time: number;
  /** Last traded price in ticks. */
  readonly last: number;
  /** Cumulative delta up to and including `ctx.bar`. */
  readonly cvd: number;
  readonly book: OrderBook | null;
  readonly position: StrategyPosition;
  /** False during warm-up and outside the trading window: order calls are ignored then. */
  readonly canTrade: boolean;
  readonly state: S;
  /** Any indicator from @htflow/indicators by id, e.g. `ctx.indicator('vwap', { bands: 2 })`. */
  indicator(id: string, inputs?: RawInputs): IndicatorHandle;
  /** Point of control (price with most volume) of a bar (default ctx.bar). */
  poc(bar?: Bar): number;
  /** Diagonal imbalances of a bar. */
  imbalances(bar?: Bar, opts?: ImbalanceOpts): Imbalance[];
  /** Longest run of consecutive same-side imbalances: count and side (null when none). */
  stackedImbalances(
    bar?: Bar,
    opts?: ImbalanceOpts,
  ): { count: number; side: 'buy' | 'sell' | null; from: number; to: number };
  buy(qty: number, opts?: OrderOpts): OrderHandle | null;
  sell(qty: number, opts?: OrderOpts): OrderHandle | null;
  buyLimit(qty: number, px: number, opts?: OrderOpts): OrderHandle | null;
  sellLimit(qty: number, px: number, opts?: OrderOpts): OrderHandle | null;
  buyStop(qty: number, stopPx: number, opts?: OrderOpts): OrderHandle | null;
  sellStop(qty: number, stopPx: number, opts?: OrderOpts): OrderHandle | null;
  /** Market-if-touched: becomes a market order when price touches `px` (buy below / sell above). */
  buyMit(qty: number, px: number, opts?: OrderOpts): OrderHandle | null;
  sellMit(qty: number, px: number, opts?: OrderOpts): OrderHandle | null;
  /** Trailing stop entry / exit that follows the best price at `trailTicks`. */
  buyTrailingStop(qty: number, trailTicks: number, opts?: OrderOpts): OrderHandle | null;
  sellTrailingStop(qty: number, trailTicks: number, opts?: OrderOpts): OrderHandle | null;
  cancel(orderId: string): boolean;
  cancelAll(): void;
  /** Closes the position at market and cancels working orders. */
  flatten(label?: string): void;
  /** Working orders of this strategy. */
  workingOrders(): OrderHandle[];
  /** Contracts for a stop of `stopTicks` risking `money` (≥ 0, rounded down to whole lots). */
  qtyForRisk(stopTicks: number, money: number): number;
  log(message: string): void;
}

export interface StrategyMeta {
  /** Stable id (kebab-case), persisted in workspaces. */
  id: string;
  name: string;
  category: StrategyCategory;
  description: string;
  /** Default bar type for backtests. */
  bars?: BarSpec;
  /** Default timeframe label, for documentation. */
  timeframe?: TimeframeId;
}

export interface StrategyDefinition<
  I extends InputDefs = InputDefs,
  S = unknown,
> extends StrategyMeta {
  inputs: I;
  /** Creates the mutable state object (called once per run). */
  init?(inputs: InputValues<I>): S;
  /** Called once per closed bar. */
  onBar?(ctx: StrategyContext<I, S>): void;
  /** Called for every trade (after bars and fills are updated). */
  onTrade?(ctx: StrategyContext<I, S>, trade: Trade): void;
  /** Called after the order book changed (at most once per event time). */
  onBook?(ctx: StrategyContext<I, S>, book: OrderBook): void;
  /** Called for every fill of this strategy's orders. */
  onFill?(ctx: StrategyContext<I, S>, fill: Fill): void;
}

/** Type-erased definition used by registries and runners. */
export type AnyStrategy = StrategyDefinition<InputDefs, unknown>;

export function defineStrategy<const I extends InputDefs, S = undefined>(
  def: StrategyDefinition<I, S>,
): StrategyDefinition<I, S> {
  return def;
}

export function asAnyStrategy<I extends InputDefs, S>(def: StrategyDefinition<I, S>): AnyStrategy {
  return def as unknown as AnyStrategy;
}

/** One log line written by `ctx.log`. */
export interface StrategyLog {
  ts: number;
  text: string;
}
