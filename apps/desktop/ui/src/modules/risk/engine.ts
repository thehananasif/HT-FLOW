import { toast } from '@htflow/ui-kit';
import {
  RiskEngine,
  dayKey,
  defaultRiskRules,
  nextDayStart,
  sanitizeRiskRules,
  type RiskLockSnapshot,
  type RiskRules,
} from '@htflow/trading';
import { backend } from '../../backend';
import { hub, paper } from '../../state/market';
import { useSession } from '../../state/session';
import { activityLog } from '../activity/log';
import { getSetting } from '../../state/settings';
import { checkGlobalLimits, increasesRisk, lockEnd, type GlobalRiskLimits } from './globalLimits';

const KEY = 'risk.settings';
export const localTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

interface Saved {
  rules: Record<string, RiskRules>;
  locks: RiskLockSnapshot;
  /** Salted SHA-256 of the override password (never the password itself). */
  override: { salt: string; hash: string } | null;
}

/** The app-wide risk engine: pre-trade checks and loss monitoring on the paper engine. */
export const risk = new RiskEngine(
  paper,
  { mark: (id) => hub.peek(id)?.lastTrade?.px },
  defaultRiskRules(localTimeZone()),
);

let override: Saved['override'] = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function save(): void {
  const rules: Record<string, RiskRules> = {};
  for (const id of paper.accounts.keys()) rules[id] = risk.rules(id);
  const data: Saved = { rules, locks: risk.snapshotLocks(), override };
  void backend.saveSettings(KEY, data);
}

export const riskStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  hasOverride: () => override !== null,
  async setOverride(password: string | null): Promise<void> {
    if (!password) override = null;
    else {
      const salt = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      override = { salt, hash: await sha256Hex(salt + password) };
    }
    save();
    notify();
  },
  async checkOverride(password: string): Promise<boolean> {
    if (!override) return true;
    return (await sha256Hex(override.salt + password)) === override.hash;
  },
  saveRules(accountId: string, rules: RiskRules): void {
    risk.setRules(accountId, rules);
    save();
    notify();
  },
  unlock(accountId: string): void {
    risk.unlock(accountId);
    unlockGlobal(accountId);
    save();
    notify();
  },
};

risk.onEvent((e) => {
  const account = paper.accounts.get(e.accountId)?.name ?? e.accountId;
  activityLog.add({
    type: e.kind === 'lock' || e.kind === 'unlock' ? 'lock' : 'risk',
    account,
    message: e.message,
  });
  if (e.kind === 'lock') toast('error', 'Risk lock', e.message, 8000);
  else if (e.kind === 'warning' || e.kind === 'flatten')
    toast('warning', 'Risk warning', e.message, 6000);
  if (e.kind === 'lock' || e.kind === 'unlock') save();
  notify();
});

/* ---------------- Settings → Risk: app-wide limits (P27) ---------------- */

interface DayState {
  day: string;
  startEquity: number;
  trades: number;
  lockedUntil: number;
  lossNotified: boolean;
}
const dayStates = new Map<string, DayState>();
let lastWarn = '';

function globalLimits(): GlobalRiskLimits {
  return {
    maxDailyLoss: getSetting('risk.maxDailyLoss'),
    maxPositionSize: getSetting('risk.maxPositionSize'),
    maxOrderSize: getSetting('risk.maxOrderSize'),
    maxTradesPerDay: getSetting('risk.maxTradesPerDay'),
    priceCollarTicks: getSetting('risk.priceCollarTicks'),
    warnAtPct: getSetting('risk.warnAtPct'),
    onBreach: getSetting('risk.onBreach'),
    lockUntil: getSetting('risk.lockUntil'),
  };
}

function accountEquity(accountId: string): number {
  const acc = paper.accounts.get(accountId);
  if (!acc) return 0;
  let open = 0;
  for (const p of paper.allPositions(accountId)) {
    const m = hub.peek(p.instrumentId)?.lastTrade?.px;
    if (m !== undefined) open += paper.unrealized(accountId, p.instrumentId, m);
  }
  return acc.balance + open;
}

function dayState(accountId: string): DayState {
  const now = Date.now();
  const day = dayKey(now, localTimeZone());
  let st = dayStates.get(accountId);
  if (!st || st.day !== day) {
    st = {
      day,
      startEquity: accountEquity(accountId),
      trades: 0,
      lockedUntil: st && st.lockedUntil > now ? st.lockedUntil : 0,
      lossNotified: false,
    };
    dayStates.set(accountId, st);
  }
  return st;
}

/** Lifts a Settings → Risk lock (Risk module "Unlock"). */
export function unlockGlobal(accountId: string): void {
  const st = dayStates.get(accountId);
  if (st) st.lockedUntil = 0;
}

function breach(accountId: string, message: string): void {
  const lim = globalLimits();
  const st = dayState(accountId);
  if (lim.onBreach === 'warn') {
    if (!st.lossNotified) toast('warning', 'Risk limit reached', message, 8000);
    st.lossNotified = true;
    return;
  }
  const now = Date.now();
  if (st.lockedUntil <= now) {
    st.lockedUntil = lockEnd(lim.lockUntil, now, nextDayStart(now, localTimeZone()));
    if (lim.onBreach === 'flatten')
      for (const p of paper.allPositions(accountId)) paper.flatten(accountId, p.instrumentId);
    toast('error', 'Trading locked (Settings → Risk)', message, 8000);
    activityLog.add({ type: 'lock', account: accountId, message });
  }
}

paper.preTradeChecks.push((req) => {
  const lim = globalLimits();
  const st = dayState(req.accountId);
  const adds = !req.reduceOnly && increasesRisk(paper.position(req.accountId, req.instrumentId).qty, req.side);
  if (adds && st.lockedUntil > Date.now()) return 'Trading is locked by Settings → Risk';
  const v = checkGlobalLimits(
    req,
    {
      position: paper.position(req.accountId, req.instrumentId).qty,
      lastPx: hub.peek(req.instrumentId)?.lastTrade?.px ?? Number.NaN,
      dayPnl: accountEquity(req.accountId) - st.startEquity,
      tradesToday: st.trades,
    },
    lim,
  );
  if (v.verdict === 'reject') {
    if (v.lossBreach) breach(req.accountId, v.message ?? 'Daily loss limit');
    return `${v.message} (Settings → Risk)`;
  }
  if (v.verdict === 'warn' && v.message && v.message !== lastWarn) {
    lastWarn = v.message;
    toast('warning', 'Risk warning', v.message, 6000);
  }
  return null;
});

// Positions opened from flat count as trades for the daily trade limit.
paper.postFillHooks.push((f) => {
  const pos = paper.position(f.accountId, f.instrumentId).qty;
  if (Math.abs(pos) === f.qty) dayState(f.accountId).trades++;
});

/** Daily-loss monitor: breaches lock (and optionally flatten) as soon as the loss is reached. */
function monitorGlobal(): void {
  const lim = globalLimits();
  if (lim.maxDailyLoss <= 0) return;
  for (const id of paper.accounts.keys()) {
    const st = dayState(id);
    const pnl = accountEquity(id) - st.startEquity;
    if (pnl <= -lim.maxDailyLoss && st.lockedUntil <= Date.now() && !st.lossNotified) {
      breach(id, `Daily loss ${Math.round(-pnl)} reached the limit of ${lim.maxDailyLoss}`);
      st.lossNotified = true;
    }
  }
}

// Mark-to-market monitoring (fills are checked synchronously by the post-fill hook).
setInterval(() => {
  risk.tick();
  monitorGlobal();
}, 250);

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  if (!id) return;
  void backend.loadSettings<Saved>(KEY).then((s) => {
    if (!s) return;
    for (const [acc, r] of Object.entries(s.rules ?? {}))
      risk.setRules(acc, sanitizeRiskRules(r, localTimeZone()));
    override = s.override ?? null;
    if (s.locks) risk.restoreLocks(s.locks);
    notify();
  });
}
useSession.subscribe(onSession);
onSession();
