/**
 * Normalised market events (Live Pipeline stage 2).
 * Prices are always integer ticks (price / tickSize) inside the engine — never floats.
 */
export type Side = 'buy' | 'sell';
export type Aggressor = Side | 'unknown';

export type AssetClass = 'crypto' | 'future' | 'stock' | 'index' | 'option';

export interface Instrument {
  /** Unique id, e.g. "binance-futures:BTCUSDT" or "mock:CLZ6". */
  id: string;
  symbol: string;
  displayName: string;
  /** Exchange or venue label shown in the UI, e.g. "NYMEX" or "Binance Futures". */
  exchange: string;
  assetClass: AssetClass;
  tickSize: number;
  pricePrecision: number;
  /** Decimal places of quantity (0 = whole lots). */
  qtyPrecision: number;
  /** Currency value of one tick for one contract (futures); 0 for linear crypto. */
  tickValue: number;
  currency: string;
}

export interface Trade {
  /** Exchange timestamp, epoch milliseconds (fractional allowed). */
  ts: number;
  /** Price in ticks. */
  px: number;
  qty: number;
  side: Aggressor;
  id: number;
}

/** [priceTicks, qty] */
export type Level = [number, number];

export interface BookSnapshot {
  ts: number;
  bids: Level[];
  asks: Level[];
}

export interface BookDelta {
  /** 'buy' = bid side, 'sell' = ask side. */
  side: Side;
  px: number;
  /** New absolute size at the level; 0 removes the level. */
  qty: number;
}

/** One coalesced batch of events (Live Pipeline stage 9 — one per frame at most). */
export interface EventBatch {
  ts: number;
  trades: Trade[];
  deltas: BookDelta[];
  snapshot?: BookSnapshot;
}

/** Resting depth sampled at a fixed interval — the data behind heatmaps. */
export interface DepthColumn {
  t: number;
  bestBid: number;
  bestAsk: number;
  pxs: Int32Array;
  qtys: Float32Array;
}

export interface HistoryData {
  trades: Trade[];
  depth: DepthColumn[];
  book: BookSnapshot;
  /** Time the history ends; live data continues from here. */
  end: number;
}

export type FeedState = 'connecting' | 'live' | 'delayed' | 'replay' | 'disconnected' | 'error';

export interface FeedStatus {
  state: FeedState;
  latencyMs: number;
  msgsPerSec: number;
  message?: string;
}

export interface FeedSource {
  readonly instrument: Instrument;
  readonly kind: 'mock' | 'live' | 'replay';
  /** Loads previous data (tick store / backfill / simulated). */
  history(): Promise<HistoryData>;
  subscribe(listener: (batch: EventBatch) => void): () => void;
  onStatus(listener: (status: FeedStatus) => void): () => void;
  start(): void;
  stop(): void;
}

export function toTicks(price: number, tickSize: number): number {
  return Math.round(price / tickSize);
}

export function fromTicks(px: number, tickSize: number): number {
  return px * tickSize;
}

export function formatPrice(
  px: number,
  inst: Pick<Instrument, 'tickSize' | 'pricePrecision'>,
): string {
  return (px * inst.tickSize).toFixed(inst.pricePrecision);
}

export function formatQty(qty: number, precision = 0): string {
  if (precision === 0) return String(Math.round(qty));
  return qty.toFixed(precision);
}

/** Compact number formatting for dense cells: 1234 → 1.2K, 1500000 → 1.5M. */
export function formatCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (a > 0 && a < 1) return v.toFixed(3);
  if (!Number.isInteger(v)) return v.toFixed(a < 10 ? 2 : 1);
  return String(v);
}
