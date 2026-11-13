import { normalizeAccountState, type AccountState, type RiskDaySnapshot } from '@htflow/trading';

/**
 * What is saved per paper account (P17): settings, the cash balance, the open state (positions,
 * working orders, brackets, options) and the risk engine's day counters.
 */
export interface SavedAccount {
  id: string;
  name: string;
  currency: string;
  startingBalance: number;
  slippageTicks: number;
  /** Cash balance (starting balance + realized PnL − commissions) when last saved. */
  balance: number;
  /** Open positions, working orders and options (absent in saves made before P17 persistence). */
  state?: AccountState;
  /** Risk day counters, so day P&L and trade counts continue after a restart. */
  risk?: RiskDaySnapshot;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function riskDay(v: unknown): RiskDaySnapshot | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  return typeof r.day === 'string' &&
    num(r.dayStartEquity) &&
    num(r.peakEquity) &&
    num(r.tradesToday) &&
    r.tradesToday >= 0
    ? {
        day: r.day,
        dayStartEquity: r.dayStartEquity,
        peakEquity: r.peakEquity,
        tradesToday: Math.floor(r.tradesToday),
      }
    : undefined;
}

/** Validates the saved list; older saves without `balance` restart at the starting balance. */
export function normalizeSavedAccounts(raw: unknown): SavedAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (a): a is Record<string, unknown> & { id: string; name: string } =>
        !!a &&
        typeof a === 'object' &&
        typeof (a as { id?: unknown }).id === 'string' &&
        typeof (a as { name?: unknown }).name === 'string',
    )
    .map((a) => {
      const startingBalance =
        num(a.startingBalance) && a.startingBalance >= 0 ? a.startingBalance : 50_000;
      const out: SavedAccount = {
        id: a.id,
        name: a.name.trim() || 'Paper',
        currency: typeof a.currency === 'string' && a.currency ? a.currency : 'USD',
        startingBalance,
        slippageTicks: num(a.slippageTicks) && a.slippageTicks >= 0 ? a.slippageTicks : 0,
        balance: num(a.balance) ? a.balance : startingBalance,
      };
      if (a.state !== undefined) out.state = normalizeAccountState(a.state);
      const r = riskDay(a.risk);
      if (r) out.risk = r;
      return out;
    });
}
