import { HT, defineIndicator, input, output, type AccountSnapshot } from '@htflow/indicator-sdk';

/** Unrealized P&L of the chart instrument's position marked at `markTicks`. */
export function positionPnl(a: AccountSnapshot, markTicks: number): number {
  if (!a.positionQty || !Number.isFinite(markTicks)) return 0;
  return (markTicks - a.avgPx) * a.positionQty * a.pnlPerTick;
}

/** Balance plus the unrealized P&L of every position (the chart's one marked at `markTicks`). */
export function accountEquity(a: AccountSnapshot, markTicks: number): number {
  return a.balance + a.otherUnrealized + positionPnl(a, markTicks);
}

export interface SizeResult {
  /** Risk budget in account currency: base x risk%. */
  budget: number;
  /** Loss of one unit if the stop is hit: stop ticks x currency per tick. */
  riskPerUnit: number;
  /** Whole units that fit the budget (0 when the stop distance or tick value is unknown). */
  units: number;
}

/** Fixed-fractional position size: floor(base · risk% / (stopTicks · pnlPerTick)). */
export function positionSize(
  base: number,
  riskPct: number,
  stopTicks: number,
  pnlPerTick: number,
): SizeResult {
  const budget = Math.max(0, base) * (riskPct / 100);
  const riskPerUnit = stopTicks * pnlPerTick;
  const units =
    riskPerUnit > 0 && Number.isFinite(riskPerUnit) ? Math.floor(budget / riskPerUnit) : 0;
  return { budget, riskPerUnit, units };
}

const money = (v: number, ccy: string) =>
  `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`;
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

/**
 * Account Info Display (Trading): the trading account's balance, equity and open P&L, read-only
 * from the paper / live store. Shown as legend values and a note on the last bar.
 */
export const AccountInfo = defineIndicator({
  id: 'account-info',
  name: 'Account Info Display',
  short: 'Account',
  category: 'trading',
  pane: 'new',
  needsHost: true,
  description:
    'Balance, equity, unrealized P&L and the open position of the active trading account, read-only.',
  formula:
    'Equity = balance + Σ unrealized P&L of open positions, the chart instrument marked at the last close',
  inputs: {},
  outputs: {
    balance: output.dots('Balance', HT.soft, { unit: 'value' }),
    equity: output.dots('Equity', HT.up, { unit: 'value' }),
    unrealized: output.dots('Unrealized P&L', HT.warning, { unit: 'value' }),
  },
  title: () => 'Account',
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const a = ctx.account;
    if (!a) {
      ctx.notice('no trading account');
      return;
    }
    const pos = positionPnl(a, ctx.bar.c);
    const unreal = a.otherUnrealized + pos;
    const equity = a.balance + unreal;
    ctx.out.balance.set(ctx.i, a.balance);
    ctx.out.equity.set(ctx.i, equity);
    ctx.out.unrealized.set(ctx.i, unreal);
    ctx.notice(
      `${a.name} · balance ${money(a.balance, a.currency)} · equity ${money(equity, a.currency)} · open P&L ${signed(unreal)} · ` +
        (a.positionQty
          ? `position ${signed(a.positionQty, 0)} @ ${(a.avgPx * ctx.tickSize).toFixed(Math.max(0, -Math.floor(Math.log10(ctx.tickSize))))}`
          : 'flat') +
        ` · ${a.openPositions} open`,
    );
  },
});

/**
 * Position Sizing Tracker (Trading): how many units a fixed-fractional risk rule allows with the
 * given stop distance, against the position that is actually open.
 */
export const PositionSizing = defineIndicator({
  id: 'position-sizing',
  name: 'Position Sizing Tracker',
  short: 'Size',
  category: 'trading',
  pane: 'new',
  needsHost: true,
  description:
    'Units allowed by a fixed risk per trade (percent of equity and a stop distance in ticks), next to the position that is open and the risk it carries.',
  formula:
    'units = floor(base · risk% / (stop ticks · currency per tick)); base = equity (marked at the last close) or balance',
  inputs: {
    risk: input.float('Risk per trade', 1, { min: 0.01, max: 100, step: 0.25, unit: '%' }),
    stop: input.int('Stop distance', 20, { min: 1, max: 100_000, unit: 'ticks' }),
    base: input.enum('Risk base', 'equity', [
      ['equity', 'Equity'],
      ['balance', 'Balance'],
    ]),
  },
  outputs: {
    size: output.dots('Allowed size', HT.up, { unit: 'count' }),
    open: output.dots('Open position', HT.info, { unit: 'count' }),
  },
  title: (p) => `Position size ${p.risk}% / ${p.stop} ticks`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const a = ctx.account;
    if (!a) {
      ctx.notice('no trading account');
      return;
    }
    const { risk, stop, base } = ctx.inputs;
    const eq = accountEquity(a, ctx.bar.c);
    const r = positionSize(base === 'balance' ? a.balance : eq, risk, stop, a.pnlPerTick);
    ctx.out.size.set(ctx.i, r.units);
    ctx.out.open.set(ctx.i, Math.abs(a.positionQty));
    const openRisk = Math.abs(a.positionQty) * r.riskPerUnit;
    ctx.notice(
      `risk ${money(r.budget, a.currency)} → ${r.units} units · open ${signed(a.positionQty, 0)} carries ${money(openRisk, a.currency)} (${eq > 0 ? ((100 * openRisk) / eq).toFixed(2) : '0.00'}% of equity)`,
    );
  },
});
