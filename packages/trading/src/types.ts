import type { Side } from '@htflow/market-data';

export type OrderType = 'market' | 'limit' | 'stop' | 'stop-limit';
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
  commissionPerUnit: number;
  /** Taker fee as fraction of notional (crypto); applied in addition to per-unit commission. */
  takerFee: number;
  locked: boolean;
}

export interface BracketSpec {
  /** Stop-loss distance in ticks from the average fill price. */
  slTicks?: number;
  /** One or more take-profit targets in ticks; quantity is split evenly. */
  tpTicks?: number[];
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
}

export interface InstrumentEconomics {
  tickSize: number;
  /** Currency per tick per contract; 0 means linear (PnL = ticks × tickSize × qty). */
  tickValue: number;
}

export function pnlPerTick(e: InstrumentEconomics, qty: number): number {
  return (e.tickValue > 0 ? e.tickValue : e.tickSize) * qty;
}
