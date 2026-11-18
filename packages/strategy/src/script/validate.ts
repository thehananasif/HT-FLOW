import type { InstrumentInfo, ScriptIntent } from './protocol';

/** Host-side limits every sandbox order must satisfy before it reaches the risk engine. */
export interface OrderLimits {
  /** Largest quantity of one order. */
  maxOrderQty: number;
  /** Largest absolute position the strategy may build. */
  maxPosition: number;
  /** Limit / stop prices must lie within this fraction of the last price (fat-finger guard). */
  maxPriceDeviation: number;
  /** Largest bracket distance in ticks. */
  maxBracketTicks: number;
}

export const DEFAULT_ORDER_LIMITS: OrderLimits = {
  maxOrderQty: 10,
  maxPosition: 10,
  maxPriceDeviation: 0.2,
  maxBracketTicks: 10_000,
};

/** A validated order (prices in ticks), ready for StrategyContext / the engine. */
export interface CheckedOrder {
  op: 'order';
  cid: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  qty: number;
  px?: number;
  bracket?: { stopTicks?: number; targetTicks?: number[]; trailTicks?: number };
  label?: string;
}

export type CheckedIntent =
  | CheckedOrder
  | { op: 'cancel'; cid: string }
  | { op: 'cancelAll' }
  | { op: 'close'; label?: string };

export type Validation = { ok: true; intent: CheckedIntent } | { ok: false; reason: string };

export interface ValidationState {
  /** Last price in ticks (NaN when unknown). */
  last: number;
  /** Current signed position. */
  position: number;
  /** Signed quantity of working entry orders already accepted this call. */
  pending?: number;
}

const LABEL = /[^\p{L}\p{N} _.:#/+-]/gu;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function ticks(v: unknown, lim: OrderLimits, what: string): number | string {
  if (!isNum(v) || v <= 0) return `${what} must be a positive number of ticks`;
  const t = Math.round(v);
  if (t > lim.maxBracketTicks) return `${what} exceeds ${lim.maxBracketTicks} ticks`;
  return t;
}

/**
 * Validates one untrusted intent from the sandbox. Checks shape, types, quantity, price sanity
 * and the strategy's position limit; converts prices to ticks. Account-level rules (daily loss,
 * max position per account, orders per minute, trading hours, locks) are enforced afterwards by
 * the RiskEngine installed on the order engine.
 */
export function validateIntent(
  raw: unknown,
  inst: InstrumentInfo,
  lim: OrderLimits,
  st: ValidationState,
): Validation {
  const bad = (reason: string): Validation => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object') return bad('Malformed intent');
  const r = raw as Record<string, unknown>;
  const label =
    typeof r.label === 'string' ? r.label.replace(LABEL, '').slice(0, 64) || undefined : undefined;
  switch (r.op) {
    case 'cancel':
      return typeof r.cid === 'string' && /^(c\d{1,9}|#[\w:-]{1,80})$/.test(r.cid)
        ? { ok: true, intent: { op: 'cancel', cid: r.cid } }
        : bad('cancel(): unknown order id');
    case 'cancelAll':
      return { ok: true, intent: { op: 'cancelAll' } };
    case 'close':
      return { ok: true, intent: { op: 'close', ...(label ? { label } : {}) } };
    case 'order':
      break;
    default:
      return bad(`Unknown operation '${String(r.op).slice(0, 20)}'`);
  }
  if (typeof r.cid !== 'string' || !/^c\d{1,9}$/.test(r.cid)) return bad('Malformed order id');
  if (r.side !== 'buy' && r.side !== 'sell') return bad('Side must be buy or sell');
  if (r.type !== 'market' && r.type !== 'limit' && r.type !== 'stop')
    return bad('Order type must be market, limit or stop');
  if (!isNum(r.qty) || r.qty <= 0) return bad('Quantity must be a positive number');
  const qty = Math.round(r.qty * 1e8) / 1e8;
  if (qty > lim.maxOrderQty) return bad(`Quantity ${qty} exceeds the max order size ${lim.maxOrderQty}`);
  const signed = r.side === 'buy' ? qty : -qty;
  const pos = st.position + (st.pending ?? 0);
  const reducing = pos !== 0 && Math.sign(signed) === -Math.sign(pos) && qty <= Math.abs(pos);
  if (!reducing && Math.abs(pos + signed) > lim.maxPosition + 1e-9)
    return bad(`Position would exceed the strategy limit of ${lim.maxPosition}`);
  let px: number | undefined;
  if (r.type !== 'market') {
    if (!isNum(r.price) || r.price <= 0) return bad(`${r.type} order needs a positive price`);
    px = Math.round(r.price / inst.tickSize);
    if (Number.isFinite(st.last) && st.last > 0) {
      const dev = Math.abs(px - st.last) / st.last;
      if (dev > lim.maxPriceDeviation)
        return bad(
          `Price ${r.price} is ${(dev * 100).toFixed(1)}% away from the last price (limit ${(lim.maxPriceDeviation * 100).toFixed(0)}%)`,
        );
    }
  }
  let bracket: CheckedOrder['bracket'];
  if (r.bracket !== undefined) {
    if (!r.bracket || typeof r.bracket !== 'object') return bad('Malformed bracket');
    const b = r.bracket as Record<string, unknown>;
    bracket = {};
    if (b.stop !== undefined) {
      const t = ticks(b.stop, lim, 'Stop');
      if (typeof t === 'string') return bad(t);
      bracket.stopTicks = t;
    }
    if (b.trail !== undefined) {
      const t = ticks(b.trail, lim, 'Trail');
      if (typeof t === 'string') return bad(t);
      bracket.trailTicks = t;
    }
    if (b.target !== undefined) {
      if (!Array.isArray(b.target) || b.target.length > 4) return bad('Up to 4 targets');
      const out: number[] = [];
      for (const x of b.target) {
        const t = ticks(x, lim, 'Target');
        if (typeof t === 'string') return bad(t);
        out.push(t);
      }
      if (out.length) bracket.targetTicks = out;
    }
    if (!Object.keys(bracket).length) bracket = undefined;
  }
  return {
    ok: true,
    intent: {
      op: 'order',
      cid: r.cid,
      side: r.side,
      type: r.type,
      qty,
      ...(px !== undefined ? { px } : {}),
      ...(bracket ? { bracket } : {}),
      ...(label ? { label } : {}),
    },
  };
}

/** Narrowing helper for tests and callers holding typed intents. */
export function isOrderIntent(i: ScriptIntent): i is Extract<ScriptIntent, { op: 'order' }> {
  return i.op === 'order';
}
