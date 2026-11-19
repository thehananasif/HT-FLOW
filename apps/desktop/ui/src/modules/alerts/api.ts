/**
 * Public Alerts API (P23) for other modules — the Indicators dialog "Alerts" tab, drawings, the
 * Command Palette, strategies.
 *
 *   import { addAlert, pushValue } from '../alerts/api';
 *   const r = addAlert({ kind: 'indicator', instrumentId, key: 'rsi14@w3', label: 'RSI (14)',
 *                        op: 'cross-up', value: 70 });
 *   if (!r.ok) showErrors(r.errors);
 *   // …then on every new indicator value:
 *   pushValue(instrumentId, 'rsi14@w3', rsi, lastPx);
 *
 * Every condition kind of `@htflow/alerts` is accepted. Options default to the Settings → Alerts
 * defaults (cool-down, expiry, repeat) and the standard actions (popup, sound, log).
 */
import {
  alertStatus,
  newAlert,
  validateCondition,
  DEFAULT_ACTIONS,
  type Alert,
  type AlertActions,
  type AlertCondition,
} from '@htflow/alerts';
import { toast } from '@htflow/ui-kit';
import { getSetting } from '../../state/settings';
import { alerts, describe, removeAlert, runActions } from './runtime';

import { translateLiteral as tl } from '@htflow/i18n';
export type { Alert, AlertActions, AlertCondition };
export { describe as describeAlert, removeAlert };

export interface AddAlertOptions {
  actions?: Partial<AlertActions>;
  /** 0 = unlimited. Default from Settings → Alerts → Default repeat ("once" = 1). */
  maxTriggers?: number;
  cooldownMs?: number;
  /** Epoch ms or null (never). Default from Settings → Alerts → Default expiry. */
  expiresAt?: number | null;
  enabled?: boolean;
  /** Fixed id (re-adding the same id replaces the alert). */
  id?: string;
  /** Show a "created" toast. */
  announce?: boolean;
}

export type AddAlertResult = { ok: true; alert: Alert } | { ok: false; errors: string[] };

/** Defaults for new alerts from Settings → Alerts. */
export function alertDefaults(now = Date.now()): {
  cooldownMs: number;
  expiresAt: number | null;
  maxTriggers: number;
} {
  const days = getSetting('alerts.defaultExpiryDays');
  return {
    cooldownMs: getSetting('alerts.cooldownSec') * 1000,
    expiresAt: days > 0 ? now + days * 86_400_000 : null,
    maxTriggers: getSetting('alerts.defaultRepeat') === 'once' ? 1 : 0,
  };
}

/** Number of alerts that can still trigger (waiting or cooling down). */
export function activeAlertCount(now = Date.now()): number {
  return alerts.list().filter((a) => {
    const s = alertStatus(a, now);
    return s === 'waiting' || s === 'cooldown';
  }).length;
}

/** Creates an alert. Validates the condition and the "Maximum active alerts" limit. */
export function addAlert(condition: AlertCondition, opts: AddAlertOptions = {}): AddAlertResult {
  const errors = validateCondition(condition);
  const replacing = opts.id ? alerts.list().some((a) => a.id === opts.id) : false;
  if (!replacing && activeAlertCount() >= getSetting('alerts.maxActive'))
    errors.push(`Maximum active alerts reached (${getSetting('alerts.maxActive')})`);
  if (errors.length) return { ok: false, errors };
  const now = Date.now();
  const d = alertDefaults(now);
  const alert = newAlert(
    condition,
    {
      actions: { ...DEFAULT_ACTIONS, ...opts.actions },
      cooldownMs: opts.cooldownMs ?? d.cooldownMs,
      expiresAt: opts.expiresAt === undefined ? d.expiresAt : opts.expiresAt,
      maxTriggers: opts.maxTriggers ?? d.maxTriggers,
      enabled: opts.enabled ?? true,
      ...(opts.id ? { id: opts.id } : {}),
    },
    now,
  );
  if (replacing) alerts.update(alert.id, { ...alert, fired: 0, lastFiredAt: null });
  else alerts.add(alert);
  if (opts.announce) toast('success', tl('Alert created'), describe(condition));
  return { ok: true, alert };
}

export function listAlerts(): Alert[] {
  return alerts.list();
}

export function updateAlert(id: string, patch: Partial<Alert>): void {
  alerts.update(id, patch);
}

export function onAlertsChange(fn: () => void): () => void {
  return alerts.onChange(fn);
}

/** Feeds one value of a series for `indicator` alerts. */
export function pushValue(instrumentId: string, key: string, value: number, px?: number): void {
  if (getSetting('alerts.enabled')) alerts.onValue(instrumentId, key, value, px);
}

/** Runs an alert's actions now (Alerts window "Test", palette). */
export function testAlert(id: string): void {
  const a = alerts.list().find((x) => x.id === id);
  if (a) runActions(a, 'Test alert (not a real trigger)');
}

export function setAllEnabled(enabled: boolean): void {
  for (const a of alerts.list()) if (a.enabled !== enabled) alerts.update(a.id, { enabled });
}
