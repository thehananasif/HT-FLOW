import {
  AlertEngine,
  describeCondition,
  formatAlertMessage,
  normalizeAlerts,
  type Alert,
  type AlertCondition,
} from '@htflow/alerts';
import { formatPrice, type MarketStore } from '@htflow/market-data';
import { toast } from '@htflow/ui-kit';
import { backend, isTauri } from '../../backend';
import { playSound, playSoundRef } from '../../sound';
import { getSetting } from '../../state/settings';
import { instrumentById } from '../../state/instruments';
import { hub } from '../../state/market';
import { useSession } from '../../state/session';
import { activityLog } from '../activity/log';
import { clearDeliveryCache, deliver, type Channel } from './delivery';

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

/** Plays an alert's sound: its own sound (built-in or one of the user's files) or the Alert event. */
export function playAlertSound(ref?: string): void {
  if (getSetting('sounds.muteAll')) return;
  if (!ref) return playSound('alert');
  const cfg = getSetting('sounds.events').alert;
  const vol = ((cfg?.volume ?? 80) / 100) * (getSetting('sounds.master') / 100);
  playSoundRef(ref, vol);
}

/** Kept for callers of the old helper: plays the Alert sound. */
export function beep(): void {
  playAlertSound();
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

let flashTimer: ReturnType<typeof setInterval> | null = null;
/** Flashes the taskbar button (desktop) and the document title until the window is focused. */
export function flashWindow(text = 'Alert'): void {
  if (isTauri)
    void import('@tauri-apps/api/window')
      .then((w) => w.getCurrentWindow().requestUserAttention(w.UserAttentionType.Critical))
      .catch(() => {});
  if (typeof document === 'undefined') return;
  if (flashTimer) clearInterval(flashTimer);
  const base = document.title.replace(/^🔔 .*? · /, '');
  let on = false;
  let n = 0;
  document.documentElement.dataset.alertFlash = '1';
  const stop = () => {
    if (flashTimer) clearInterval(flashTimer);
    flashTimer = null;
    document.title = base;
    delete document.documentElement.dataset.alertFlash;
    window.removeEventListener('focus', stop);
    document.removeEventListener('pointerdown', stop);
  };
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `🔔 ${text} · ${base}` : base;
    // Up to 30 s, or until the user comes back.
    if (++n > 30 || (document.hasFocus() && n > 6)) stop();
  }, 1000);
  window.addEventListener('focus', stop);
  document.addEventListener('pointerdown', stop, { once: true });
}

/** Runs the actions of one alert (also used by "Test" in the Alerts window). */
export function runActions(alert: Alert, message: string, px?: number, ts = Date.now()): void {
  const title = describe(alert.condition);
  const id = alert.condition.instrumentId;
  const inst = id ? instrumentById(id) : undefined;
  const body = `${message}${px !== undefined && inst ? ` @ ${formatPrice(px, inst)}` : ''}`;
  const a = alert.actions;
  if (a.popup && getSetting('alerts.toast')) toast('warning', `Alert: ${title}`, body, 8000);
  if (a.sound) playAlertSound(a.soundRef);
  if (a.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted')
    new Notification(`HT Flow alert: ${title}`, { body });
  if (a.flash || getSetting('alerts.flashTitle')) flashWindow(title);
  if (a.log)
    activityLog.add({
      type: 'alert',
      account: inst?.symbol ?? 'Alerts',
      message: `${title} — ${body}`,
    });
  const channels: Channel[] = [];
  if (a.telegram) channels.push('telegram');
  if (a.discord) channels.push('discord');
  if (channels.length)
    void deliver(channels, formatAlertMessage(title, body, ts)).then((errors) => {
      for (const e of errors) {
        activityLog.add({ type: 'alert', account: 'Alerts', message: `Delivery failed: ${e}` });
        toast('error', 'Alert delivery failed', e, 6000);
      }
    });
}

alerts.onFire(({ alert, message, px, ts }) => runActions(alert, message, px, ts));

/**
 * Fires an ad-hoc alert through the same local actions as engine alerts (toast, sound, log).
 * Drawing alerts now run inside the engine (`drawing` condition); this stays for other callers.
 */
export function notify(o: {
  title: string;
  body: string;
  instrumentId?: string;
  popup?: boolean;
  sound?: boolean;
  log?: boolean;
}): void {
  const inst = o.instrumentId ? instrumentById(o.instrumentId) : undefined;
  if (o.popup ?? true) toast('warning', `Alert: ${o.title}`, o.body, 8000);
  if (o.sound ?? true) playAlertSound();
  if (o.log ?? true)
    activityLog.add({
      type: 'alert',
      account: inst?.symbol ?? 'Alerts',
      message: `${o.title} — ${o.body}`,
    });
}

/* ---------------- market wiring ---------------- */

const live = () => getSetting('alerts.enabled');

const attached = new WeakSet<MarketStore>();
function attach(store: MarketStore): void {
  if (attached.has(store)) return;
  attached.add(store);
  const id = store.instrument.id;
  store.onTrades((trades) => live() && alerts.onTrades(id, trades));
  store.onFunding((f) => live() && alerts.onFunding(id, f));
  store.onLiquidation((l) => live() && alerts.onLiquidations(id, l));
  let lastBook = -1;
  let lastState = '';
  store.subscribe(() => {
    if (store.status.state !== lastState) {
      lastState = store.status.state;
      if (live()) alerts.onStatus(id, lastState);
    }
    // Book checks at most once per book version.
    if (store.book.version !== lastBook) {
      lastBook = store.book.version;
      if (live()) alerts.onBook(id, store.book);
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

/* ---------------- public API (Indicators dialog, drawings, palette) ---------------- */

const drawingRemovers = new Set<(a: Alert) => void>();
/** Called when a drawing alert is deleted from the Alerts window (clears the drawing's flag). */
export function onDrawingAlertRemoved(fn: (a: Alert) => void): () => void {
  drawingRemovers.add(fn);
  return () => drawingRemovers.delete(fn);
}

export { removeAlertImpl as removeAlert };
function removeAlertImpl(id: string): void {
  const a = alerts.list().find((x) => x.id === id);
  // Clear the drawing's flag first, so the drawings sync does not re-create the alert.
  if (a?.condition.kind === 'drawing') for (const fn of drawingRemovers) fn(a);
  alerts.remove(id);
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
  clearDeliveryCache();
  loading = true;
  alerts.set([]);
  loading = false;
  if (!id) return;
  void backend.loadSettings<unknown>(KEY).then((saved) => {
    // Alerts created before the load finished (e.g. drawing alerts synced at start) are kept.
    const loaded = normalizeAlerts(saved);
    const ids = new Set(loaded.map((a) => a.id));
    loading = true;
    alerts.set([...loaded, ...alerts.list().filter((a) => !ids.has(a.id))]);
    loading = false;
    syncRetained();
  });
}
useSession.subscribe(onSession);
onSession();
