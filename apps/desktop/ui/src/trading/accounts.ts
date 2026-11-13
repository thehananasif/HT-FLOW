import type { Account } from '@htflow/trading';
import { paper, PAPER_ACCOUNT } from '../state/market';
import { Persisted } from './persist';
import { normalizeSavedAccounts, type SavedAccount } from './accountsModel';
import { setPrefs, tradingPrefs } from './prefs';
import { risk, restoreRiskDay } from '../modules/risk/engine';
import { beforeExit } from '../state/exit';
// Options mark-to-model and expiry settlement (P18).
import './optionsModel';

export type { SavedAccount };

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'USDT', 'USDC', 'BTC'];

const store = new Persisted<SavedAccount[]>('trading.accounts', () => [], normalizeSavedAccounts);

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
    balance: a.balance,
    // Open positions, working orders and options survive a restart (P17).
    state: paper.exportAccountState(a.id),
    risk: risk.snapshotDay(a.id),
  }));

/** Nothing happened on the account this session, so its saved state may be applied. */
const untouched = (id: string): boolean => {
  const a = paper.accounts.get(id);
  return (
    !!a &&
    a.balance === a.startingBalance &&
    !paper.fills.some((f) => f.accountId === id) &&
    !paper.optionFills.some((f) => f.accountId === id) &&
    paper.workingOrders(id).length === 0 &&
    paper.allPositions(id).length === 0 &&
    paper.optionPositions(id).length === 0
  );
};

/** Balance and open state of a saved account, then the risk engines re-based on it. */
function restoreOpenState(s: SavedAccount): void {
  const a = paper.accounts.get(s.id);
  if (!a) return;
  a.balance = s.balance;
  if (s.state) paper.importAccountState(s.id, s.state);
  restoreRiskDay(s.id, s.risk);
}

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
      if (!cur) {
        paper.createAccount({
          id: s.id,
          name: s.name,
          currency: s.currency,
          startingBalance: s.startingBalance,
          slippageTicks: s.slippageTicks,
        });
        restoreOpenState(s);
      } else {
        const fresh = untouched(s.id);
        paper.updateAccount(s.id, {
          name: s.name,
          currency: s.currency,
          startingBalance: s.startingBalance,
          slippageTicks: s.slippageTicks,
        });
        // An account untouched this session resumes at its saved balance and open state.
        if (fresh) restoreOpenState(s);
      }
    }
  } finally {
    applying = false;
  }
  ensureActive();
});

let last = '';
function persistNow(): void {
  if (applying || !store.loaded) return;
  const snap = snapshot();
  const json = JSON.stringify(snap);
  if (json === last) return;
  last = json;
  store.set(snap);
}
paper.subscribe(persistNow);
// Trades between paper events still move risk day counters: save them now and then.
setInterval(persistNow, 5_000);
// Write the latest open state before the window closes (the store debounces writes).
beforeExit.push(() => {
  persistNow();
  return store.flush();
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
