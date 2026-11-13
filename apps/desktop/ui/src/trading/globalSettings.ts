/**
 * Settings → Trading (P27) applied to every trading surface: default quantity, quick-size
 * presets, default order type / time in force, order hot keys, one-click, market-order slippage
 * guard, automatic SL / TP bracket and the chart order / position lines. Pure helpers are tested;
 * `tradingDefaults()` reads the live settings.
 */
import type { BracketSpec, OrderRequest, TimeInForce } from '@htflow/trading';
import { getSetting } from '../state/settings';

/** "1, 2,5,x,10" → [1, 2, 5, 10] (positive numbers, unique, at most 8). */
export function parseQtyPresets(s: string): number[] {
  const out: number[] = [];
  for (const part of String(s).split(/[,;\s]+/)) {
    const n = Number(part);
    if (part && Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
    if (out.length >= 8) break;
  }
  return out.length ? out : [1, 2, 5, 10];
}

export function tifOf(v: string): TimeInForce {
  return v === 'day' ? 'DAY' : v === 'ioc' ? 'IOC' : v === 'fok' ? 'FOK' : 'GTC';
}

/** Automatic OCO bracket from Settings → Trading (stop / target distances in ticks). */
export function autoBracket(stopTicks: number, targetTicks: number): BracketSpec {
  return { slTicks: Math.max(1, stopTicks), tpTicks: [Math.max(1, targetTicks)] };
}

/**
 * Slippage guard for market orders: the worst price level the order would take from the book,
 * in ticks from the best quote. Null when the book is empty on that side.
 */
export function marketSlippageTicks(
  side: 'buy' | 'sell',
  qty: number,
  levels: Iterable<[number, number]>,
): number | null {
  const sorted = [...levels].filter(([, q]) => q > 0).sort((a, b) => (side === 'buy' ? a[0] - b[0] : b[0] - a[0]));
  if (!sorted.length) return null;
  const best = sorted[0]![0];
  let left = qty;
  let worst = best;
  for (const [px, q] of sorted) {
    worst = px;
    left -= q;
    if (left <= 0) break;
  }
  return Math.abs(worst - best);
}

/** Reason to reject a market order whose fill would slip more than `maxTicks`, or null. */
export function slippageReason(
  req: Pick<OrderRequest, 'type' | 'side' | 'qty'>,
  levels: Iterable<[number, number]>,
  maxTicks: number,
): string | null {
  if (req.type !== 'market' || maxTicks <= 0) return null;
  const t = marketSlippageTicks(req.side, req.qty, levels);
  if (t === null || t <= maxTicks) return null;
  return `Slippage ${t} ticks exceeds the ${maxTicks}-tick limit (Settings → Trading)`;
}

export interface TradingDefaults {
  qty: number;
  qtyPresets: number[];
  orderType: 'market' | 'limit' | 'stop';
  tif: TimeInForce;
  oneClick: boolean;
  orderHotkeys: boolean;
  slippageTicks: number;
  autoBracket: boolean;
  stopTicks: number;
  targetTicks: number;
  showOrderLines: boolean;
  showPositionLine: boolean;
  confirmOrders: boolean;
}

export function tradingDefaults(): TradingDefaults {
  const g = <T>(k: string, d: T): T => {
    try {
      const v = getSetting(k as never) as unknown;
      return (v === undefined ? d : v) as T;
    } catch {
      return d;
    }
  };
  const ot = g<string>('trading.defaultOrderType', 'limit');
  return {
    qty: g('trading.defaultQty', 1),
    qtyPresets: parseQtyPresets(g('trading.qtyPresets', '1,2,5,10')),
    orderType: ot === 'market' || ot === 'stop' ? ot : 'limit',
    tif: tifOf(g('trading.defaultTif', 'gtc')),
    oneClick: g('trading.oneClick', true),
    orderHotkeys: g('trading.orderHotkeys', true),
    slippageTicks: g('trading.slippageTicks', 5),
    autoBracket: g('trading.autoBracket', false),
    stopTicks: g('trading.stopTicks', 20),
    targetTicks: g('trading.targetTicks', 40),
    showOrderLines: g('trading.showOrderLines', true),
    showPositionLine: g('trading.showPositionLine', true),
    confirmOrders: g('general.confirmOrders', false),
  };
}
