/** What is saved per paper account (P17): settings and the cash balance. */
export interface SavedAccount {
  id: string;
  name: string;
  currency: string;
  startingBalance: number;
  slippageTicks: number;
  /**
   * Cash balance (starting balance + realized PnL − commissions) when last saved. Open positions
   * are not saved yet, so a restart resumes flat at this balance.
   */
  balance: number;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
      return {
        id: a.id,
        name: a.name.trim() || 'Paper',
        currency: typeof a.currency === 'string' && a.currency ? a.currency : 'USD',
        startingBalance,
        slippageTicks: num(a.slippageTicks) && a.slippageTicks >= 0 ? a.slippageTicks : 0,
        balance: num(a.balance) ? a.balance : startingBalance,
      };
    });
}
