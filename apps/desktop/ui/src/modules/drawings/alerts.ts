/**
 * Drawing alerts, unified with the Alerts engine (P12 / P23). A drawing's "Alert on cross" flag is
 * the source of truth; this module keeps one engine alert (`drawing` condition, id `dr-<drawing>`)
 * per flagged drawing, so drawing alerts show up in the Alerts window, share its actions
 * (Telegram / Discord, flash, sounds) and keep firing while the chart window is closed or hidden.
 */
import {
  alertChannels,
  describeAlertEvent,
  detectAlert,
  supportsAlert,
  toolDef,
} from '@htflow/drawings';
import type { Alert, AlertCondition } from '@htflow/alerts';
import { formatPrice } from '@htflow/market-data';
import { instrumentById } from '../../state/instruments';
import { useWindows } from '../../state/windows';
import { alerts, onDrawingAlertRemoved } from '../alerts/runtime';
import { mutate, readDrawings } from './store';

type DrawingCond = Extract<AlertCondition, { kind: 'drawing' }>;

export const drawingAlertId = (drawingId: string) => `dr-${drawingId}`;

export interface WantedDrawingAlert {
  id: string;
  condition: DrawingCond;
  popup: boolean;
  sound: boolean;
  log: boolean;
  once: boolean;
}

/**
 * Pure: the drawing alerts that should exist for the given chart windows. A synced drawing that
 * appears in several charts yields one alert (first window wins).
 */
export function wantedDrawingAlerts(
  windows: { id: string; instrumentId: string; drawings: ReturnType<typeof readDrawings> }[],
): WantedDrawingAlert[] {
  const out = new Map<string, WantedDrawingAlert>();
  for (const w of windows)
    for (const d of w.drawings) {
      if (!d.alert || d.hidden || !supportsAlert(d.type)) continue;
      const id = drawingAlertId(d.id);
      if (out.has(id)) continue;
      const ch = alertChannels(d);
      out.set(id, {
        id,
        condition: {
          kind: 'drawing',
          instrumentId: w.instrumentId,
          windowId: w.id,
          drawingId: d.id,
          label: toolDef(d.type)?.label ?? 'Drawing',
        },
        popup: ch.toast,
        sound: ch.sound,
        log: ch.log,
        once: ch.once,
      });
    }
  return [...out.values()];
}

function chartWindows() {
  const ws = useWindows.getState().windows;
  return Object.entries(ws)
    .filter(([, w]) => w.kind === 'chart')
    .map(([id, w]) => ({
      id,
      instrumentId: (w as { instrumentId: string }).instrumentId,
      drawings: readDrawings(id),
    }));
}

const same = (a: Alert, w: WantedDrawingAlert) =>
  JSON.stringify(a.condition) === JSON.stringify(w.condition) &&
  a.actions.popup === w.popup &&
  a.actions.sound === w.sound &&
  a.actions.log === w.log &&
  a.maxTriggers === (w.once ? 1 : 0);

let syncing = false;
/** Reconciles engine drawing alerts with the drawings' flags. */
export function syncDrawingAlerts(): void {
  if (syncing) return;
  syncing = true;
  try {
    const want = wantedDrawingAlerts(chartWindows());
    const byId = new Map(want.map((w) => [w.id, w]));
    for (const a of alerts.list())
      if (a.condition.kind === 'drawing' && !byId.has(a.id)) alerts.remove(a.id);
    for (const w of want) {
      const cur = alerts.list().find((a) => a.id === w.id);
      if (cur && same(cur, w)) continue;
      const actions = {
        ...(cur?.actions ?? { desktop: false, flash: false, telegram: false, discord: false }),
        popup: w.popup,
        sound: w.sound,
        log: w.log,
      };
      if (cur)
        alerts.update(w.id, { condition: w.condition, actions, maxTriggers: w.once ? 1 : 0 });
      else
        alerts.add({
          id: w.id,
          condition: w.condition,
          actions,
          enabled: true,
          maxTriggers: w.once ? 1 : 0,
          fired: 0,
          lastFiredAt: null,
          expiresAt: null,
          // Small debounce: a jittery print around the line fires once.
          cooldownMs: 1500,
          createdAt: Date.now(),
        });
    }
  } finally {
    syncing = false;
  }
}

alerts.setDrawingDetector((c, prev, cur) => {
  const d = readDrawings(c.windowId).find((x) => x.id === c.drawingId);
  if (!d || !d.alert || d.hidden) return null;
  const ev = detectAlert(d, prev, cur);
  if (!ev) return null;
  const inst = instrumentById(c.instrumentId);
  const level = Math.round(ev.level);
  const label = toolDef(d.type)?.label ?? 'drawing';
  return {
    message: `${describeAlertEvent(ev, label)} @ ${inst ? formatPrice(level, inst) : level}`,
    px: cur.px,
  };
});

// Deleting a drawing alert in the Alerts window turns the drawing's flag off.
onDrawingAlertRemoved((a) => {
  const c = a.condition;
  if (c.kind !== 'drawing') return;
  for (const w of chartWindows())
    if (w.drawings.some((d) => d.id === c.drawingId && d.alert))
      mutate(w.id, (items) =>
        items.map((d) => (d.id === c.drawingId ? { ...d, alert: false } : d)),
      );
});

let lastWindows: unknown = null;
useWindows.subscribe((s) => {
  if (s.windows === lastWindows) return;
  lastWindows = s.windows;
  syncDrawingAlerts();
});
// After a profile load replaces the engine list, re-add flags the saved list did not have.
alerts.onChange(() => syncDrawingAlerts());
syncDrawingAlerts();
