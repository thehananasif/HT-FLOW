/**
 * Order proposals from the model's `place_order` tool call: risk maths for the order card and the
 * conversion back to tool arguments after the trader edits the card. Prices are in price units.
 */
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

export interface Proposal {
  side: Side;
  type: OrderType;
  qty: number;
  /** Entry reference: limit price, stop trigger, or the last price for market orders. */
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface Economics {
  tickSize: number;
  /** Currency per tick per contract; 0 = linear (PnL = ticks × tickSize × qty). */
  tickValue: number;
}

export type CardIssue = 'noEntry' | 'noQty' | 'noStop' | 'stopSide' | 'targetSide';

export interface CardMath {
  riskTicks: number | null;
  rewardTicks: number | null;
  /** Money at risk if the stop is hit (account currency). */
  risk: number | null;
  reward: number | null;
  /** Reward / risk. */
  r: number | null;
  issues: CardIssue[];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;

const round = (v: number, d = 8) => Number(v.toFixed(d));

/** Currency value of one tick for `qty` units. */
export function moneyPerTick(e: Economics, qty: number): number {
  return (e.tickValue > 0 ? e.tickValue : e.tickSize) * qty;
}

/**
 * Reads a `place_order` argument object. Stop-loss / take-profit arrive as tick distances from
 * the entry; they are turned into prices on the protective side of the entry.
 */
export function proposalFromArgs(
  raw: unknown,
  ctx: { tickSize: number; last?: number | null },
): Proposal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const side = a.side === 'buy' || a.side === 'sell' ? a.side : null;
  const type = a.type === 'market' || a.type === 'limit' || a.type === 'stop' ? a.type : null;
  if (!side || !type) return null;
  const px = num(a.price);
  const stop = num(a.stopPrice);
  const entry = type === 'limit' ? px : type === 'stop' ? stop : (ctx.last ?? px ?? stop);
  const dir = side === 'buy' ? 1 : -1;
  const slT = num(a.stopLossTicks);
  const tpT = num(a.takeProfitTicks);
  const at = (ticks: number | null, sign: 1 | -1) =>
    entry !== null && ticks !== null && ticks > 0
      ? round(entry + sign * dir * ticks * ctx.tickSize)
      : null;
  return {
    side,
    type,
    qty: num(a.qty) ?? 0,
    entry: entry ?? null,
    stopLoss: at(slT, -1),
    takeProfit: at(tpT, 1),
  };
}

export function cardMath(p: Proposal, e: Economics): CardMath {
  const issues: CardIssue[] = [];
  if (!(p.qty > 0)) issues.push('noQty');
  if (p.entry === null) issues.push('noEntry');
  if (p.stopLoss === null) issues.push('noStop');
  const dir = p.side === 'buy' ? 1 : -1;
  let riskTicks: number | null = null;
  let rewardTicks: number | null = null;
  if (p.entry !== null && e.tickSize > 0) {
    if (p.stopLoss !== null) {
      const d = (p.entry - p.stopLoss) * dir;
      if (d <= 0) issues.push('stopSide');
      else riskTicks = d / e.tickSize;
    }
    if (p.takeProfit !== null) {
      const d = (p.takeProfit - p.entry) * dir;
      if (d <= 0) issues.push('targetSide');
      else rewardTicks = d / e.tickSize;
    }
  }
  const per = moneyPerTick(e, p.qty > 0 ? p.qty : 0);
  const risk = riskTicks !== null ? round(riskTicks * per, 2) : null;
  const reward = rewardTicks !== null ? round(rewardTicks * per, 2) : null;
  return {
    riskTicks: riskTicks !== null ? round(riskTicks, 2) : null,
    rewardTicks: rewardTicks !== null ? round(rewardTicks, 2) : null,
    risk,
    reward,
    r: riskTicks && rewardTicks !== null ? round(rewardTicks / riskTicks, 2) : null,
    issues,
  };
}

/** Tool arguments for an (edited) proposal; unrelated arguments (symbol) are kept. */
export function proposalToArgs(
  base: unknown,
  p: Proposal,
  tickSize: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...(base && typeof base === 'object' && !Array.isArray(base) ? (base as object) : {}),
  };
  out.side = p.side;
  out.type = p.type;
  out.qty = p.qty;
  delete out.price;
  delete out.stopPrice;
  delete out.stopLossTicks;
  delete out.takeProfitTicks;
  if (p.type === 'limit' && p.entry !== null) out.price = p.entry;
  if (p.type === 'stop' && p.entry !== null) out.stopPrice = p.entry;
  if (p.entry !== null && tickSize > 0) {
    if (p.stopLoss !== null)
      out.stopLossTicks = Math.max(1, Math.round(Math.abs(p.entry - p.stopLoss) / tickSize));
    if (p.takeProfit !== null)
      out.takeProfitTicks = Math.max(1, Math.round(Math.abs(p.takeProfit - p.entry) / tickSize));
  }
  return out;
}
