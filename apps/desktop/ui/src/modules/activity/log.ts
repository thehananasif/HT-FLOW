import { formatPrice } from '@htflow/market-data';
import { backend } from '../../backend';
import { instrumentById } from '../../state/instruments';
import { hub, paper } from '../../state/market';
import { useSession } from '../../state/session';
import { pruneActivity, type ActivityEvent, type ActivityType } from './prune';

export type { ActivityEvent, ActivityType };

const KEY = 'activity.log';

let events: ActivityEvent[] = [];
let seq = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of listeners) l();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void backend.saveSettings(KEY, events), 1000);
}

/** Trading Activity log (P40): every account event, kept 90 days, persisted per user. */
export const activityLog = {
  add(e: { type: ActivityType; message: string; account?: string; ts?: number }): void {
    const ts = e.ts ?? Date.now();
    events = pruneActivity(
      [
        ...events,
        {
          id: `${ts.toString(36)}-${(seq++).toString(36)}`,
          ts,
          type: e.type,
          account: e.account ?? '',
          message: e.message,
        },
      ],
      Date.now(),
    );
    changed();
  },
  list(): ActivityEvent[] {
    return events;
  },
  clear(): void {
    events = [];
    changed();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

const accName = (id: string) => paper.accounts.get(id)?.name ?? id;
const sym = (id: string) => instrumentById(id)?.symbol ?? id;
const px = (id: string, v: number | undefined) => {
  const i = instrumentById(id);
  return v === undefined ? '—' : i ? formatPrice(v, i) : String(v);
};

// ---- auto-capture from the paper engine (fills, brackets, cancels, rejections, locks) ----
let fillIdx = 0;
const orderStatus = new Map<string, string>();
const lockState = new Map<string, boolean>();
const bracketsSeen = new Set<string>();

function scanPaper(): void {
  for (; fillIdx < paper.fills.length; fillIdx++) {
    const f = paper.fills[fillIdx]!;
    const o = paper.orders.get(f.orderId);
    const kind = o?.role && o.role !== 'entry' ? o.role.toUpperCase() : (o?.type ?? 'market');
    activityLog.add({
      type: 'fill',
      account: accName(f.accountId),
      message: `${f.side.toUpperCase()} ${f.qty} ${sym(f.instrumentId)} @ ${px(f.instrumentId, f.px)} (${kind}, ${f.liquidity})`,
    });
  }
  for (const o of paper.orders.values()) {
    const prev = orderStatus.get(o.id);
    if (prev === o.status) continue;
    orderStatus.set(o.id, o.status);
    if (!prev && o.parentId && !bracketsSeen.has(o.parentId)) {
      bracketsSeen.add(o.parentId);
      const legs = [...paper.orders.values()].filter((x) => x.parentId === o.parentId);
      activityLog.add({
        type: 'bracket',
        account: accName(o.accountId),
        message:
          legs
            .map((l) => `${l.role?.toUpperCase()} ${px(l.instrumentId, l.px ?? l.stopPx)}`)
            .join(' + ') + ` placed for ${sym(o.instrumentId)} (OCO)`,
      });
    }
    if (o.status === 'rejected')
      activityLog.add({
        type: 'reject',
        account: accName(o.accountId),
        message: `${o.side.toUpperCase()} ${o.qty} ${sym(o.instrumentId)} rejected: ${o.reason ?? 'unknown'}`,
      });
    else if (o.status === 'cancelled' && prev)
      activityLog.add({
        type: 'cancel',
        account: accName(o.accountId),
        message: `${o.side.toUpperCase()} ${o.type} ${o.qty} ${sym(o.instrumentId)} @ ${px(o.instrumentId, o.px ?? o.stopPx)} cancelled`,
      });
  }
  for (const a of paper.accounts.values()) {
    const prev = lockState.get(a.id) ?? false;
    if (prev !== a.locked) {
      lockState.set(a.id, a.locked);
      activityLog.add({
        type: 'lock',
        account: a.name,
        message: a.locked ? 'Account locked' : 'Account unlocked',
      });
    }
  }
}
paper.subscribe(scanPaper);

// ---- connection errors from hub store status changes ----
hub.onStore((store) => {
  let last = store.status.state;
  store.subscribe(() => {
    const st = store.status.state;
    if (st === last) return;
    const bad = st === 'error' || st === 'disconnected';
    const wasBad = last === 'error' || last === 'disconnected';
    last = st;
    if (bad)
      activityLog.add({
        type: 'connection',
        account: store.instrument.exchange,
        message: `${store.instrument.symbol}: ${st}${store.status.message ? ` — ${store.status.message}` : ''}`,
      });
    else if (wasBad && st === 'live')
      activityLog.add({
        type: 'connection',
        account: store.instrument.exchange,
        message: `${store.instrument.symbol}: connection restored`,
      });
  });
});

// ---- per-user persistence ----
let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  if (!id) {
    events = [];
    return;
  }
  void backend.loadSettings<ActivityEvent[]>(KEY).then((saved) => {
    if (Array.isArray(saved)) events = pruneActivity([...saved, ...events], Date.now());
    for (const l of listeners) l();
  });
}
useSession.subscribe(onSession);
onSession();
