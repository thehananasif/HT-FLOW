import { toast } from '@htflow/ui-kit';
import {
  RiskEngine,
  defaultRiskRules,
  sanitizeRiskRules,
  type RiskLockSnapshot,
  type RiskRules,
} from '@htflow/trading';
import { backend } from '../../backend';
import { hub, paper } from '../../state/market';
import { useSession } from '../../state/session';
import { activityLog } from '../activity/log';

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

// Mark-to-market monitoring (fills are checked synchronously by the post-fill hook).
setInterval(() => risk.tick(), 250);

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
