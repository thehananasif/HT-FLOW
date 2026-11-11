import { AlertEngine, describeCondition, type Alert, type AlertCondition } from '@htflow/alerts';
import { formatPrice, type MarketStore } from '@htflow/market-data';
import { toast } from '@htflow/ui-kit';
import { backend } from '../../backend';
import { instrumentById } from '../../state/instruments';
import { hub } from '../../state/market';
import { useSession } from '../../state/session';
import { activityLog } from '../activity/log';

const KEY = 'alerts.list';

/** App-wide alert engine: runs on hub stores, independent of any open window (P23 / P41). */
export const alerts = new AlertEngine();

export const describe = (c: AlertCondition): string =>
  describeCondition(c, {
    symbol: (id) => instrumentById(id)?.symbol ?? id,
    price: (id, px) => {
      const i = instrumentById(id);
      return i ? formatPrice(px, i) : String(px);
    },
  });

/* ---------------- actions ---------------- */

let audio: AudioContext | null = null;
/** Short two-tone WebAudio beep (no sound files needed). */
export function beep(): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    [880, 660].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16);
      o.stop(ctx.currentTime + i * 0.16 + 0.15);
    });
  } catch {
    // Audio unavailable (no device / autoplay policy): the other actions still run.
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

alerts.onFire(({ alert, message, px }) => {
  const title = describe(alert.condition);
  const id = alert.condition.instrumentId;
  const inst = id ? instrumentById(id) : undefined;
  const body = `${message}${px !== undefined && inst ? ` @ ${formatPrice(px, inst)}` : ''}`;
  if (alert.actions.popup) toast('warning', `Alert: ${title}`, body, 8000);
  if (alert.actions.sound) beep();
  if (
    alert.actions.desktop &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  )
    new Notification(`HT Flow alert: ${title}`, { body });
  if (alert.actions.log)
    activityLog.add({
      type: 'alert',
      account: inst?.symbol ?? 'Alerts',
      message: `${title} — ${body}`,
    });
});

/* ---------------- market wiring ---------------- */

const attached = new WeakSet<MarketStore>();
function attach(store: MarketStore): void {
  if (attached.has(store)) return;
  attached.add(store);
  const id = store.instrument.id;
  store.onTrades((trades) => alerts.onTrades(id, trades));
  let lastBook = -1;
  let lastState = '';
  store.subscribe(() => {
    if (store.status.state !== lastState) {
      lastState = store.status.state;
      alerts.onStatus(id, lastState);
    }
    // Book checks at most once per book version.
    if (store.book.version !== lastBook) {
      lastBook = store.book.version;
      alerts.onBook(id, store.book);
    }
  });
}
hub.onStore(attach);
for (const s of hub.stores()) attach(s);

/** Keep feeds alive for instruments with live alerts, even when no window shows them. */
const retained = new Set<string>();
function syncRetained(): void {
  const want = new Set(useSession.getState().session ? alerts.instruments() : []);
  for (const id of want)
    if (!retained.has(id) && instrumentById(id)) {
      retained.add(id);
      attach(hub.retain(id));
    }
  for (const id of [...retained])
    if (!want.has(id)) {
      retained.delete(id);
      hub.release(id);
    }
}

/* ---------------- persistence (per user) ---------------- */

let loading = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
alerts.onChange(() => {
  syncRetained();
  if (loading || !useSession.getState().session) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void backend.saveSettings(KEY, alerts.list()), 500);
});

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  loading = true;
  alerts.set([]);
  loading = false;
  if (!id) return;
  void backend.loadSettings<Alert[]>(KEY).then((saved) => {
    loading = true;
    alerts.set(Array.isArray(saved) ? saved : []);
    loading = false;
    syncRetained();
  });
}
useSession.subscribe(onSession);
onSession();
