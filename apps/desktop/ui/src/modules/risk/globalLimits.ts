/**
 * Settings → Risk (P27): app-wide limits on top of the per-account rules of the Risk module.
 * Pure checks (tested); `engine.ts` installs them as a paper-engine pre-trade check and runs the
 * daily-loss monitor.
 */
import type { OrderRequest } from '@htflow/trading';

export interface GlobalRiskLimits {
  /** 0 = off for every numeric limit. */
  maxDailyLoss: number;
  maxPositionSize: number;
  maxOrderSize: number;
  maxTradesPerDay: number;
  priceCollarTicks: number;
  /** Warn when a limit is this % used. */
  warnAtPct: number;
  onBreach: string;
  lockUntil: string;
}

export interface RiskContext {
  /** Signed position before the order. */
  position: number;
  /** Last price (ticks); NaN when unknown. */
  lastPx: number;
  /** Day P&L (realised + open) in account currency. */
  dayPnl: number;
  /** Positions opened today. */
  tradesToday: number;
}

export interface RiskVerdict {
  verdict: 'ok' | 'warn' | 'reject';
  message?: string;
  /** True when the daily loss limit is the reason (locks the account under block / flatten). */
  lossBreach?: boolean;
}

/** Whether the order adds to (or opens) a position. */
export function increasesRisk(position: number, side: 'buy' | 'sell'): boolean {
  return position === 0 || (position > 0) === (side === 'buy');
}

export function checkGlobalLimits(
  req: Pick<OrderRequest, 'side' | 'qty' | 'type' | 'px' | 'reduceOnly'>,
  ctx: RiskContext,
  lim: GlobalRiskLimits,
): RiskVerdict {
  const adds = !req.reduceOnly && increasesRisk(ctx.position, req.side);
  const hard: { msg: string; loss?: boolean }[] = [];
  const soft: string[] = [];
  const warnAt = Math.max(0.1, Math.min(1, lim.warnAtPct / 100));
  const usage = (used: number, max: number, what: string) => {
    if (max > 0 && used >= warnAt * max && used <= max)
      soft.push(`${what} at ${Math.round((used / max) * 100)}% of the limit`);
  };

  if (lim.maxOrderSize > 0) {
    if (req.qty > lim.maxOrderSize)
      hard.push({ msg: `Order size ${req.qty} exceeds the limit of ${lim.maxOrderSize}` });
    else usage(req.qty, lim.maxOrderSize, 'Order size');
  }
  const next = ctx.position + (req.side === 'buy' ? req.qty : -req.qty);
  if (lim.maxPositionSize > 0 && Math.abs(next) > Math.abs(ctx.position)) {
    if (Math.abs(next) > lim.maxPositionSize)
      hard.push({
        msg: `Position ${Math.abs(next)} would exceed the limit of ${lim.maxPositionSize}`,
      });
    else usage(Math.abs(next), lim.maxPositionSize, 'Position');
  }
  if (
    lim.priceCollarTicks > 0 &&
    (req.type === 'limit' || req.type === 'stop-limit') &&
    req.px !== undefined &&
    Number.isFinite(ctx.lastPx) &&
    Math.abs(req.px - ctx.lastPx) > lim.priceCollarTicks
  )
    hard.push({
      msg: `Limit price is ${Math.abs(req.px - ctx.lastPx)} ticks from the market (collar ${lim.priceCollarTicks})`,
    });
  if (adds && ctx.position === 0 && lim.maxTradesPerDay > 0) {
    if (ctx.tradesToday >= lim.maxTradesPerDay)
      hard.push({ msg: `Daily trade limit of ${lim.maxTradesPerDay} reached` });
    else usage(ctx.tradesToday + 1, lim.maxTradesPerDay, 'Trades today');
  }
  if (adds && lim.maxDailyLoss > 0) {
    if (ctx.dayPnl <= -lim.maxDailyLoss)
      hard.push({ msg: `Daily loss limit of ${lim.maxDailyLoss} reached`, loss: true });
    else if (ctx.dayPnl < 0) usage(-ctx.dayPnl, lim.maxDailyLoss, 'Daily loss');
  }

  if (hard.length) {
    const msg = hard.map((h) => h.msg).join('; ');
    return {
      verdict: lim.onBreach === 'warn' ? 'warn' : 'reject',
      message: msg,
      lossBreach: hard.some((h) => h.loss),
    };
  }
  if (soft.length) return { verdict: 'warn', message: soft.join('; ') };
  return { verdict: 'ok' };
}

/** When a lock after a breach ends (Settings → Risk → lock until). */
export function lockEnd(lockUntil: string, now: number, nextDayStart: number): number {
  if (lockUntil === 'hour') return now + 3_600_000;
  if (lockUntil === 'manual') return Infinity;
  return nextDayStart;
}
