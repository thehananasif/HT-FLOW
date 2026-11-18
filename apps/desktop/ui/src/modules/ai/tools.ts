/**
 * Tools the model may call. They are executed by the app (never by the provider): read tools
 * report market / account state, trade tools go through the paper engine, where the agent guard
 * and the risk engine's pre-trade checks can reject them.
 */
import type { PaperEngine } from '@htflow/trading';
import type { Trade } from '@htflow/market-data';
import { AGENT_TAG, type AgentGuard } from './guard';
import type { AiToolDef } from './native';

export interface MarketView {
  symbol: string;
  tickSize: number;
  pricePrecision: number;
  lastPx?: number;
  bestBid?: number;
  bestAsk?: number;
  trades: readonly Trade[];
}

export interface ToolDeps {
  paper: PaperEngine;
  guard: AgentGuard;
  accountId(): string;
  /** Instrument id for a symbol / id the model gave (or the active chart's when omitted). */
  resolve(symbol: string | undefined): string | null;
  market(instrumentId: string): MarketView | undefined;
  dayPnl(accountId: string): number;
  /** Per-trade confirmation (agent limits → "confirm each trade"). */
  confirm(summary: string): Promise<boolean>;
  addAlert(instrumentId: string, pxTicks: number, direction: 'up' | 'down' | 'any'): string | null;
  now(): number;
}

export type ToolName =
  | 'get_market_data'
  | 'get_footprint_stats'
  | 'get_positions'
  | 'get_account'
  | 'get_orders'
  | 'place_order'
  | 'modify_order'
  | 'cancel_order'
  | 'close_position'
  | 'set_alert';

export const TRADE_TOOLS: ReadonlySet<string> = new Set([
  'place_order',
  'modify_order',
  'cancel_order',
  'close_position',
]);

const sym = {
  type: 'string',
  description: 'Instrument symbol or id, e.g. BTCUSDT. Omit for the active chart.',
};

export const TOOL_DEFS: AiToolDef[] = [
  {
    name: 'get_market_data',
    description:
      'Last price, best bid / ask, spread and recent range, volume and VWAP of an instrument.',
    parameters: {
      type: 'object',
      properties: {
        symbol: sym,
        minutes: { type: 'number', description: 'Look-back window, default 15' },
      },
    },
  },
  {
    name: 'get_footprint_stats',
    description:
      'Order-flow statistics: buy / sell volume, delta, cumulative delta per minute, point of control, top volume levels with bid / ask split, and large prints.',
    parameters: {
      type: 'object',
      properties: {
        symbol: sym,
        minutes: { type: 'number', description: 'Look-back window, default 15' },
      },
    },
  },
  {
    name: 'get_positions',
    description: 'Open positions of the trading account.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_account',
    description: 'Balance, equity, day P&L and whether the account is paper or live.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_orders',
    description: 'Working orders of the trading account.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'place_order',
    description:
      'Place an order. Prices are in price units. Optional bracket: stop-loss / take-profit distance in ticks.',
    parameters: {
      type: 'object',
      properties: {
        symbol: sym,
        side: { type: 'string', enum: ['buy', 'sell'] },
        type: { type: 'string', enum: ['market', 'limit', 'stop'] },
        qty: { type: 'number' },
        price: { type: 'number', description: 'Limit price (limit orders)' },
        stopPrice: { type: 'number', description: 'Trigger price (stop orders)' },
        stopLossTicks: { type: 'number' },
        takeProfitTicks: { type: 'number' },
      },
      required: ['side', 'type', 'qty'],
    },
  },
  {
    name: 'modify_order',
    description: 'Change price, stop price or quantity of a working order.',
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        price: { type: 'number' },
        stopPrice: { type: 'number' },
        qty: { type: 'number' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'cancel_order',
    description: 'Cancel a working order.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
  },
  {
    name: 'close_position',
    description: 'Flatten the position in an instrument at market.',
    parameters: { type: 'object', properties: { symbol: sym } },
  },
  {
    name: 'set_alert',
    description: 'Create a price alert that fires when the last price crosses a level.',
    parameters: {
      type: 'object',
      properties: {
        symbol: sym,
        price: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down', 'any'] },
      },
      required: ['price'],
    },
  },
];

export const READ_TOOL_DEFS = TOOL_DEFS.filter(
  (t) => !TRADE_TOOLS.has(t.name) && t.name !== 'set_alert',
);

export interface ToolOutcome {
  ok: boolean;
  /** JSON-serialisable result given back to the model. */
  result: unknown;
  /** One-line summary for the audit log. */
  summary: string;
}

const round = (v: number, d = 8) => Number(v.toFixed(d));
const args = (a: unknown): Record<string, unknown> =>
  a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
const fail = (summary: string): ToolOutcome => ({ ok: false, result: { error: summary }, summary });

function windowTrades(m: MarketView, minutes: number, now: number): Trade[] {
  const from = now - Math.max(1, Math.min(240, minutes)) * 60_000;
  return m.trades.filter((t) => t.ts >= from);
}

/** Pure order-flow statistics over trades (prices in ticks → price units with `tick`). */
export function flowStats(trades: readonly Trade[], tick: number, bigQty?: number) {
  let buy = 0;
  let sell = 0;
  const levels = new Map<number, { bid: number; ask: number }>();
  const perMin = new Map<number, number>();
  for (const t of trades) {
    const l = levels.get(t.px) ?? { bid: 0, ask: 0 };
    if (t.side === 'buy') {
      buy += t.qty;
      l.ask += t.qty;
    } else if (t.side === 'sell') {
      sell += t.qty;
      l.bid += t.qty;
    }
    levels.set(t.px, l);
    const m = Math.floor(t.ts / 60_000) * 60_000;
    perMin.set(m, (perMin.get(m) ?? 0) + (t.side === 'buy' ? t.qty : t.side === 'sell' ? -t.qty : 0));
  }
  const sorted = [...levels.entries()].sort((a, b) => b[1].bid + b[1].ask - (a[1].bid + a[1].ask));
  const sizes = trades.map((t) => t.qty).sort((a, b) => a - b);
  const threshold = bigQty ?? (sizes.length ? sizes[Math.floor(sizes.length * 0.98)]! : 0);
  let cum = 0;
  return {
    buyVolume: round(buy),
    sellVolume: round(sell),
    delta: round(buy - sell),
    trades: trades.length,
    poc: sorted.length ? round(sorted[0]![0] * tick) : null,
    topLevels: sorted.slice(0, 10).map(([px, v]) => ({
      price: round(px * tick),
      bidVolume: round(v.bid),
      askVolume: round(v.ask),
      delta: round(v.ask - v.bid),
    })),
    cumulativeDeltaPerMinute: [...perMin.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, d]) => ({ minute: new Date(ts).toISOString().slice(11, 16), cumDelta: round((cum += d)) })),
    largePrints: trades
      .filter((t) => threshold > 0 && t.qty >= threshold)
      .slice(-10)
      .map((t) => ({ price: round(t.px * tick), qty: t.qty, side: t.side, time: new Date(t.ts).toISOString() })),
  };
}

export async function runTool(name: string, rawArgs: unknown, d: ToolDeps): Promise<ToolOutcome> {
  const a = args(rawArgs);
  const accountId = d.accountId();
  const account = d.paper.accounts.get(accountId);
  const now = d.now();
  const instrument = () => d.resolve(typeof a.symbol === 'string' ? a.symbol : undefined);
  switch (name as ToolName) {
    case 'get_market_data': {
      const id = instrument();
      const m = id ? d.market(id) : undefined;
      if (!id || !m) return fail('Unknown instrument');
      const tr = windowTrades(m, num(a.minutes) ?? 15, now);
      let vol = 0;
      let pv = 0;
      let hi = -Infinity;
      let lo = Infinity;
      for (const t of tr) {
        vol += t.qty;
        pv += t.px * t.qty;
        hi = Math.max(hi, t.px);
        lo = Math.min(lo, t.px);
      }
      const p = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : round(v * m.tickSize));
      const result = {
        instrument: id,
        symbol: m.symbol,
        last: p(m.lastPx),
        bid: p(m.bestBid),
        ask: p(m.bestAsk),
        spread:
          m.bestBid !== undefined && m.bestAsk !== undefined && Number.isFinite(m.bestAsk - m.bestBid)
            ? round((m.bestAsk - m.bestBid) * m.tickSize)
            : null,
        tickSize: m.tickSize,
        windowMinutes: num(a.minutes) ?? 15,
        volume: round(vol),
        vwap: vol ? round((pv / vol) * m.tickSize) : null,
        high: tr.length ? p(hi) : null,
        low: tr.length ? p(lo) : null,
      };
      return { ok: true, result, summary: `${m.symbol} last ${result.last ?? '—'}` };
    }
    case 'get_footprint_stats': {
      const id = instrument();
      const m = id ? d.market(id) : undefined;
      if (!id || !m) return fail('Unknown instrument');
      const s = flowStats(windowTrades(m, num(a.minutes) ?? 15, now), m.tickSize);
      return { ok: true, result: { instrument: id, ...s }, summary: `${m.symbol} delta ${s.delta}` };
    }
    case 'get_positions': {
      const pos = d.paper.allPositions(accountId).map((p) => {
        const m = d.market(p.instrumentId);
        const tick = m?.tickSize ?? 1;
        return {
          instrument: p.instrumentId,
          qty: p.qty,
          avgPrice: round(p.avgPx * tick),
          unrealized:
            m?.lastPx !== undefined ? round(d.paper.unrealized(accountId, p.instrumentId, m.lastPx), 2) : null,
          realized: round(p.realized, 2),
        };
      });
      return { ok: true, result: { account: accountId, positions: pos }, summary: `${pos.length} positions` };
    }
    case 'get_account': {
      if (!account) return fail('Unknown account');
      const dayPnl = d.dayPnl(accountId);
      return {
        ok: true,
        result: {
          id: account.id,
          name: account.name,
          kind: account.kind,
          currency: account.currency,
          balance: round(account.balance, 2),
          dayPnl: round(dayPnl, 2),
          locked: account.locked,
        },
        summary: `${account.name} balance ${account.balance.toFixed(2)}`,
      };
    }
    case 'get_orders': {
      const orders = d.paper.workingOrders(accountId).map((o) => {
        const tick = d.market(o.instrumentId)?.tickSize ?? 1;
        return {
          orderId: o.id,
          instrument: o.instrumentId,
          side: o.side,
          type: o.type,
          qty: o.qty,
          filled: o.filled,
          price: o.px !== undefined ? round(o.px * tick) : null,
          stopPrice: o.stopPx !== undefined ? round(o.stopPx * tick) : null,
          role: o.role ?? null,
        };
      });
      return { ok: true, result: { orders }, summary: `${orders.length} working orders` };
    }
    case 'place_order': {
      const id = instrument();
      const m = id ? d.market(id) : undefined;
      if (!id || !m) return fail('Unknown instrument');
      if (!account) return fail('Unknown account');
      const side = a.side === 'buy' || a.side === 'sell' ? a.side : null;
      const type = a.type === 'market' || a.type === 'limit' || a.type === 'stop' ? a.type : null;
      const qty = num(a.qty);
      if (!side || !type || qty === undefined) return fail('side, type and qty are required');
      const px = num(a.price);
      const stop = num(a.stopPrice);
      if (type === 'limit' && px === undefined) return fail('Limit orders need a price');
      if (type === 'stop' && stop === undefined) return fail('Stop orders need a stopPrice');
      const desc = `${side.toUpperCase()} ${qty} ${m.symbol} ${type}${px !== undefined ? ` @ ${px}` : ''}${stop !== undefined ? ` stop ${stop}` : ''}`;
      const pre = d.guard.check(
        { accountId, instrumentId: id, qty },
        { accountKind: account.kind, dayPnl: d.dayPnl(accountId), now },
      );
      if (pre) return fail(`Rejected: ${pre}`);
      if (d.guard.limits.confirmEachTrade && !(await d.confirm(desc)))
        return fail('Rejected: the user declined the order');
      const sl = num(a.stopLossTicks);
      const tp = num(a.takeProfitTicks);
      const order = d.paper.place({
        accountId,
        instrumentId: id,
        side,
        type,
        qty,
        px: px !== undefined ? Math.round(px / m.tickSize) : undefined,
        stopPx: stop !== undefined ? Math.round(stop / m.tickSize) : undefined,
        tag: AGENT_TAG,
        bracket:
          sl || tp
            ? { ...(sl ? { slTicks: Math.round(sl) } : {}), ...(tp ? { tpTicks: [Math.round(tp)] } : {}) }
            : undefined,
      });
      if (order.status === 'rejected') return fail(`Rejected: ${order.reason ?? 'risk check'}`);
      return {
        ok: true,
        result: { orderId: order.id, status: order.status, filled: order.filled, avgFillPrice: order.filled ? round(order.avgFillPx * m.tickSize) : null },
        summary: `${desc} → ${order.status}`,
      };
    }
    case 'modify_order': {
      const o = typeof a.orderId === 'string' ? d.paper.orders.get(a.orderId) : undefined;
      if (!o || o.accountId !== accountId || (o.status !== 'working' && o.status !== 'partial'))
        return fail('No such working order');
      const tick = d.market(o.instrumentId)?.tickSize ?? 1;
      const qty = num(a.qty);
      if (d.guard.isKilled) return fail('Rejected: AI kill switch is on');
      if (qty !== undefined && qty > d.guard.limits.maxQty)
        return fail(`Rejected: AI limit: quantity ${qty} is above the maximum ${d.guard.limits.maxQty}`);
      const changes: { px?: number; stopPx?: number; qty?: number } = {};
      const px = num(a.price);
      const stop = num(a.stopPrice);
      if (px !== undefined) changes.px = Math.round(px / tick);
      if (stop !== undefined) changes.stopPx = Math.round(stop / tick);
      if (qty !== undefined) changes.qty = qty;
      if (!Object.keys(changes).length) return fail('Nothing to change');
      if (d.guard.limits.confirmEachTrade && !(await d.confirm(`Modify ${o.id}: ${JSON.stringify(a)}`)))
        return fail('Rejected: the user declined the change');
      const ok = d.paper.modify(o.id, changes);
      return ok
        ? { ok: true, result: { orderId: o.id, modified: true }, summary: `Modified ${o.id}` }
        : fail('The order could not be modified');
    }
    case 'cancel_order': {
      const o = typeof a.orderId === 'string' ? d.paper.orders.get(a.orderId) : undefined;
      if (!o || o.accountId !== accountId) return fail('No such order');
      const ok = d.paper.cancel(o.id);
      return ok ? { ok: true, result: { orderId: o.id, cancelled: true }, summary: `Cancelled ${o.id}` } : fail('Not cancellable');
    }
    case 'close_position': {
      const id = instrument();
      if (!id) return fail('Unknown instrument');
      const pos = d.paper.position(accountId, id);
      if (!pos.qty) return { ok: true, result: { closed: false, reason: 'flat' }, summary: `${id} already flat` };
      if (d.guard.isKilled) return fail('Rejected: AI kill switch is on');
      if (account && account.kind !== 'paper' && !d.guard.isLiveArmed)
        return fail('Rejected: live trading is not armed');
      if (d.guard.limits.confirmEachTrade && !(await d.confirm(`Close ${pos.qty} ${id} at market`)))
        return fail('Rejected: the user declined');
      d.paper.flatten(accountId, id);
      return { ok: true, result: { closed: true, qty: pos.qty }, summary: `Closed ${pos.qty} ${id}` };
    }
    case 'set_alert': {
      const id = instrument();
      const m = id ? d.market(id) : undefined;
      const px = num(a.price);
      if (!id || !m || px === undefined) return fail('symbol and price are required');
      const dir = a.direction === 'up' || a.direction === 'down' ? a.direction : 'any';
      const err = d.addAlert(id, Math.round(px / m.tickSize), dir);
      return err ? fail(err) : { ok: true, result: { created: true }, summary: `Alert ${m.symbol} ${dir} ${px}` };
    }
    default:
      return fail(`Unknown tool ${name}`);
  }
}
