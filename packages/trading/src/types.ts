import type { Side } from '@htflow/market-data';

/**
 * Order types. `mit` = market-if-touched (trigger in `stopPx`, opposite direction to a stop);
 * `trailing-stop` follows the best price by `trail`. An iceberg is a `limit` with `displayQty`.
 */
export type OrderType = 'market' | 'limit' | 'stop' | 'stop-limit' | 'mit' | 'trailing-stop';

/** Trailing distance: fixed ticks, percent of price, or a multiple of ATR (in ticks). */
export interface TrailSpec {
  kind: 'ticks' | 'percent' | 'atr';
  amount: number;
  /** ATR in ticks captured at placement; used when the engine has no live ATR source. */
  atrTicks?: number;
}
export type TimeInForce = 'GTC' | 'DAY' | 'IOC' | 'FOK' | 'GTD';
export type OrderStatus = 'working' | 'partial' | 'filled' | 'cancelled' | 'rejected';

/** One order model shared by every execution provider (paper, replay, broker). */
export interface Order {
  id: string;
  accountId: string;
  instrumentId: string;
  side: Side;
  type: OrderType;
  qty: number;
  filled: number;
  /** Limit price in ticks. */
  px?: number;
  /** Stop trigger price in ticks. */
  stopPx?: number;
  tif: TimeInForce;
  reduceOnly: boolean;
  status: OrderStatus;
  avgFillPx: number;
  createdAt: number;
  updatedAt: number;
  /** Orders sharing an OCO group cancel each other when one fills. */
  oco?: string;
  parentId?: string;
  role?: 'entry' | 'sl' | 'tp';
  reason?: string;
  /** Free-form journal tag, e.g. 'replay' (copied to fills and bracket children). */
  tag?: string;
  /** Iceberg: quantity shown to the market; refilled from the hidden rest after each slice fills. */
  displayQty?: number;
  /** Iceberg: number of refills so far. */
  refills?: number;
  /** Trailing stop distance. */
  trail?: TrailSpec;
  /** Trailing stop: best price seen since placement (ticks). */
  trailRef?: number;
  /** ATM template name that produced this order's bracket (display only). */
  atm?: string;
}

/** Quantity currently shown to the market (iceberg slice or the whole remaining quantity). */
export function visibleQty(o: Pick<Order, 'qty' | 'filled' | 'displayQty'>): number {
  const rem = o.qty - o.filled;
  return o.displayQty && o.displayQty > 0 ? Math.min(o.displayQty, rem) : rem;
}

export interface Fill {
  id: string;
  orderId: string;
  accountId: string;
  instrumentId: string;
  side: Side;
  qty: number;
  px: number;
  ts: number;
  commission: number;
  liquidity: 'maker' | 'taker';
  /** Realized PnL booked by this fill (after the position update, before commission). */
  realized: number;
  tag?: string;
}

export interface Position {
  instrumentId: string;
  /** Signed quantity: > 0 long, < 0 short. */
  qty: number;
  /** Average entry price in ticks (fractional allowed). */
  avgPx: number;
  realized: number;
}

export interface Account {
  id: string;
  name: string;
  kind: 'paper' | 'replay' | 'broker';
  currency: string;
  startingBalance: number;
  /** Cash balance: starting balance + realized PnL − commissions. */
  balance: number;
  /** Commission per unit per side (futures); charged on maker and taker fills alike. */
  commissionPerUnit: number;
  /** Taker fee as fraction of notional (crypto); applied in addition to per-unit commission. */
  takerFee: number;
  /**
   * Maker fee as fraction of notional (negative = rebate). When undefined the taker fee is used,
   * so accounts created before maker fees existed keep one flat rate.
   */
  makerFee?: number;
  /** Extra ticks of slippage applied to stop / MIT / trailing-stop market fills (default 0). */
  slippageTicks?: number;
  locked: boolean;
}

/** Signed options position held by a paper account (minimal model: premium in, mark-to-model). */
export interface OptionPosition {
  id: string;
  accountId: string;
  underlyingId: string;
  right: 'call' | 'put';
  /** Strike in price units (not ticks). */
  strike: number;
  /** Expiry as an ISO date (YYYY-MM-DD). */
  expiry: string;
  /** Signed contracts: > 0 long, < 0 short. */
  qty: number;
  /** Average premium per unit of underlying (price units). */
  avgPremium: number;
  /** Units of underlying per contract (e.g. 100 for equity options, 1 for crypto). */
  multiplier: number;
  realized: number;
  /** Last mark (premium per unit) set by the model hook or by hand. */
  mark?: number;
}

export interface OptionTradeRequest {
  accountId: string;
  underlyingId: string;
  right: 'call' | 'put';
  strike: number;
  expiry: string;
  side: Side;
  qty: number;
  /** Premium per unit of underlying (price units). */
  premium: number;
  multiplier?: number;
}

export interface BracketSpec {
  /** Stop-loss distance in ticks from the average fill price. */
  slTicks?: number;
  /** When set, the stop-loss is a trailing stop with this distance (slTicks sets its start). */
  slTrail?: TrailSpec;
  /** One or more take-profit targets in ticks; quantity is split evenly unless tpQty is given. */
  tpTicks?: number[];
  /** Relative weights of the targets' quantities (same length as tpTicks). */
  tpQty?: number[];
  /** Auto-breakeven: once profit reaches `trigger` ticks, move the stop to entry + `offset` ticks. */
  breakeven?: { trigger: number; offset: number };
  /** Trailing steps: once profit reaches `trigger` ticks, move the stop to entry + `stopOffset`. */
  trailSteps?: { trigger: number; stopOffset: number }[];
  /** ATM template name (shown on the orders). */
  atm?: string;
}

export interface OrderRequest {
  accountId: string;
  instrumentId: string;
  side: Side;
  type: OrderType;
  qty: number;
  px?: number;
  stopPx?: number;
  tif?: TimeInForce;
  reduceOnly?: boolean;
  bracket?: BracketSpec;
  tag?: string;
  /** Iceberg display quantity (limit orders). */
  displayQty?: number;
  /** Trailing distance (trailing-stop orders). */
  trail?: TrailSpec;
}

export interface InstrumentEconomics {
  tickSize: number;
  /** Currency per tick per contract; 0 means linear (PnL = ticks × tickSize × qty). */
  tickValue: number;
}

export function pnlPerTick(e: InstrumentEconomics, qty: number): number {
  return (e.tickValue > 0 ? e.tickValue : e.tickSize) * qty;
}
