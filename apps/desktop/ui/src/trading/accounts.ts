import type { Account } from '@htflow/trading';
import { paper, PAPER_ACCOUNT } from '../state/market';
import { Persisted } from './persist';
import { setPrefs, tradingPrefs } from './prefs';

/** What is saved per paper account (balances restart from the starting balance each session). */
export interface SavedAccount {
  id: string;
  name: string;
  currency: string;
  startingBalance: number;
  slippageTicks: number;
}

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'USDT', 'USDC', 'BTC'];

const normalize = (raw: unknown): SavedAccount[] =>
  Array.isArray(raw)
    ? raw
        .filter(
          (a): a is SavedAccount =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as SavedAccount).id === 'string' &&
            typeof (a as SavedAccount).name === 'string',
        )
        .map((a) => ({
          id: a.id,
          name: a.name.trim() || 'Paper',
          currency: typeof a.currency === 'string' && a.currency ? a.currency : 'USD',
          startingBalance:
            typeof a.startingBalance === 'number' && a.startingBalance >= 0
              ? a.startingBalance
              : 50_000,
          slippageTicks:
            typeof a.slippageTicks === 'number' && a.slippageTicks >= 0 ? a.slippageTicks : 0,
        }))
    : [];

const store = new Persisted<SavedAccount[]>('trading.accounts', () => [], normalize);

/** Paper accounts the user can pick (replay accounts are routed to, never picked). */
export function pickableAccounts(): Account[] {
  return [...paper.accounts.values()].filter((a) => a.kind === 'paper');
}

const snapshot = (): SavedAccount[] =>
  pickableAccounts().map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    startingBalance: a.startingBalance,
    slippageTicks: a.slippageTicks ?? 0,
  }));

let applying = false;

store.onLoaded(() => {
  applying = true;
  try {
    const saved = store.get();
    const ids = new Set(saved.map((s) => s.id));
    // Accounts of another profile go away (the default account always stays).
    for (const a of pickableAccounts())
      if (a.id !== PAPER_ACCOUNT && !ids.has(a.id)) paper.deleteAccount(a.id);
    for (const s of saved) {
      const cur = paper.accounts.get(s.id);
      if (!cur)
        paper.createAccount({
          id: s.id,
          name: s.name,
          currency: s.currency,
          startingBalance: s.startingBalance,
          slippageTicks: s.slippageTicks,
        });
      else {
        const fresh =
          !paper.fills.some((f) => f.accountId === s.id) && cur.balance === cur.startingBalance;
        paper.updateAccount(s.id, {
          name: s.name,
          currency: s.currency,
          startingBalance: s.startingBalance,
          slippageTicks: s.slippageTicks,
        });
        if (fresh) cur.balance = s.startingBalance;
      }
    }
  } finally {
    applying = false;
  }
  ensureActive();
});

let last = '';
paper.subscribe(() => {
  if (applying || !store.loaded) return;
  const snap = snapshot();
  const json = JSON.stringify(snap);
  if (json === last) return;
  last = json;
  store.set(snap);
});

/** Keeps the selected account valid (falls back to the default paper account). */
export function ensureActive(): string {
  const id = tradingPrefs.get().activeAccount;
  if (paper.accounts.get(id)?.kind === 'paper') return id;
  setPrefs({ activeAccount: PAPER_ACCOUNT });
  return PAPER_ACCOUNT;
}

/** The account new orders are sent to (before replay routing). */
export function activeAccount(): string {
  const id = tradingPrefs.get().activeAccount;
  return paper.accounts.has(id) ? id : PAPER_ACCOUNT;
}

/** The account that really trades `instrumentId` (a replay instrument → the replay account). */
export function routedAccount(instrumentId: string | null | undefined): Account {
  const id = activeAccount();
  const routed = instrumentId ? paper.route(id, instrumentId) : id;
  return paper.accounts.get(routed) ?? paper.accounts.get(PAPER_ACCOUNT)!;
}

let seq = 0;

export function createPaperAccount(
  name: string,
  startingBalance = 50_000,
  currency = 'USD',
): Account {
  const id = `paper-${Date.now().toString(36)}${(++seq).toString(36)}`;
  return paper.createAccount({ id, name: name.trim() || 'Paper', startingBalance, currency });
}

/** Deletes a paper account; the default account cannot be deleted. */
export function deletePaperAccount(id: string): boolean {
  if (id === PAPER_ACCOUNT) return false;
  const ok = paper.deleteAccount(id);
  if (ok) ensureActive();
  return ok;
}

export function selectAccount(id: string): void {
  if (paper.accounts.get(id)?.kind === 'paper') setPrefs({ activeAccount: id });
}

/** Masked account id for display, e.g. "••••3505". */
export function maskId(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, '').slice(-4);
  return `••••${tail}`;
}
