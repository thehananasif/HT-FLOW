import type { AccountState } from './paperEngine';
import type { BracketSpec, Fill, OptionPosition, Order, Position } from './types';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

const ORDER_TYPES = new Set(['market', 'limit', 'stop', 'stop-limit', 'mit', 'trailing-stop']);
const TIFS = new Set(['GTC', 'DAY', 'IOC', 'FOK', 'GTD']);

function position(v: unknown): Position | null {
  if (!obj(v) || !str(v.instrumentId) || !num(v.qty) || v.qty === 0 || !num(v.avgPx)) return null;
  return {
    instrumentId: v.instrumentId,
    qty: v.qty,
    avgPx: v.avgPx,
    realized: num(v.realized) ? v.realized : 0,
  };
}

/** A saved working order, or null when it cannot work any more (bad prices, wrong status). */
function order(v: unknown): Order | null {
  if (!obj(v) || !str(v.id) || !str(v.instrumentId) || !str(v.accountId)) return null;
  if (v.side !== 'buy' && v.side !== 'sell') return null;
  if (!ORDER_TYPES.has(v.type as string) || v.type === 'market') return null;
  if (v.status !== 'working' && v.status !== 'partial') return null;
  if (!num(v.qty) || !(v.qty > 0) || !num(v.filled) || v.filled < 0 || v.filled >= v.qty)
    return null;
  const needsPx = v.type === 'limit' || v.type === 'stop-limit';
  const needsStop = v.type !== 'limit';
  if (needsPx && !num(v.px)) return null;
  if (needsStop && !num(v.stopPx)) return null;
  // Everything else is plain data the engine wrote itself; keep it after the checks above.
  const o = { ...(v as unknown as Order) };
  o.tif = TIFS.has(o.tif) ? o.tif : 'GTC';
  o.reduceOnly = o.reduceOnly === true;
  o.avgFillPx = num(o.avgFillPx) ? o.avgFillPx : 0;
  o.createdAt = num(o.createdAt) ? o.createdAt : 0;
  o.updatedAt = num(o.updatedAt) ? o.updatedAt : o.createdAt;
  if (o.oco !== undefined && !str(o.oco)) delete o.oco;
  if (o.parentId !== undefined && !str(o.parentId)) delete o.parentId;
  if (o.type === 'trailing-stop' && (!obj(o.trail) || !num(o.trail.amount))) return null;
  return o;
}

function option(v: unknown): OptionPosition | null {
  if (!obj(v) || !str(v.id) || !str(v.underlyingId) || !str(v.expiry)) return null;
  if (v.right !== 'call' && v.right !== 'put') return null;
  if (!num(v.strike) || !(v.strike > 0) || !num(v.qty) || v.qty === 0) return null;
  if (!num(v.avgPremium) || v.avgPremium < 0) return null;
  const p: OptionPosition = {
    id: v.id,
    accountId: str(v.accountId) ? v.accountId : '',
    underlyingId: v.underlyingId,
    right: v.right,
    strike: v.strike,
    expiry: v.expiry,
    qty: v.qty,
    avgPremium: v.avgPremium,
    multiplier: num(v.multiplier) && v.multiplier > 0 ? v.multiplier : 1,
    realized: num(v.realized) ? v.realized : 0,
  };
  if (num(v.mark)) p.mark = v.mark;
  if (str(v.name)) p.name = v.name;
  if (num(v.expiryTs)) p.expiryTs = v.expiryTs;
  if (num(v.iv) && v.iv > 0) p.iv = v.iv;
  if (v.model === 'bs' || v.model === 'b76') p.model = v.model;
  if (num(v.r)) p.r = v.r;
  if (num(v.q)) p.q = v.q;
  if (num(v.basis) && v.basis > 0) p.basis = v.basis;
  return p;
}

function fill(v: unknown): Fill | null {
  if (!obj(v) || !str(v.id) || !str(v.orderId) || !str(v.instrumentId)) return null;
  if (v.side !== 'buy' && v.side !== 'sell') return null;
  if (!num(v.qty) || !(v.qty > 0) || !num(v.px) || !num(v.ts)) return null;
  const f: Fill = {
    id: v.id,
    orderId: v.orderId,
    accountId: str(v.accountId) ? v.accountId : '',
    instrumentId: v.instrumentId,
    side: v.side,
    qty: v.qty,
    px: v.px,
    ts: v.ts,
    commission: num(v.commission) ? v.commission : 0,
    liquidity: v.liquidity === 'maker' ? 'maker' : 'taker',
    realized: num(v.realized) ? v.realized : 0,
  };
  if (num(v.closedQty) && v.closedQty > 0) f.closedQty = v.closedQty;
  if (num(v.entryAvg)) f.entryAvg = v.entryAvg;
  if (str(v.tag)) f.tag = v.tag;
  return f;
}

const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : [];

/**
 * Validates a saved account state (P17 persistence). Bad entries are dropped one by one, so a
 * damaged save restores whatever is still sound; anything unreadable gives an empty state.
 */
export function normalizeAccountState(raw: unknown): AccountState {
  const empty: AccountState = {
    v: 1,
    positions: [],
    orders: [],
    brackets: [],
    managed: [],
    options: [],
    fills: [],
  };
  if (!obj(raw) || raw.v !== 1) return empty;
  const orders = list(raw.orders, order);
  const ids = new Set(orders.map((o) => o.id));
  // Orders of a bracket whose children were dropped stay; an OCO group of one is no group.
  const groups = new Map<string, number>();
  for (const o of orders) if (o.oco) groups.set(o.oco, (groups.get(o.oco) ?? 0) + 1);
  for (const o of orders) if (o.oco && !o.parentId && groups.get(o.oco) === 1) delete o.oco;
  return {
    v: 1,
    positions: list(raw.positions, position),
    orders,
    brackets: list(raw.brackets, (b) =>
      obj(b) && str(b.entryId) && ids.has(b.entryId) && obj(b.spec)
        ? { entryId: b.entryId, spec: b.spec as BracketSpec }
        : null,
    ),
    managed: list(raw.managed, (m) =>
      obj(m) &&
      str(m.entryId) &&
      str(m.instrumentId) &&
      (m.dir === 1 || m.dir === -1) &&
      num(m.avg) &&
      Array.isArray(m.steps)
        ? {
            entryId: m.entryId,
            instrumentId: m.instrumentId,
            dir: m.dir,
            avg: m.avg,
            breakeven:
              obj(m.breakeven) && num(m.breakeven.trigger) && num(m.breakeven.offset)
                ? { trigger: m.breakeven.trigger, offset: m.breakeven.offset }
                : undefined,
            steps: (m.steps as unknown[]).filter(
              (x): x is { trigger: number; stopOffset: number } =>
                obj(x) && num(x.trigger) && num(x.stopOffset),
            ),
            beDone: m.beDone === true,
          }
        : null,
    ),
    options: list(raw.options, option),
    fills: list(raw.fills, fill),
  };
}
