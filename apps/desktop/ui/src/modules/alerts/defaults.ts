/** Settings → Alerts defaults for new alerts (P27). Pure, tested. */
import type { Alert } from '@htflow/alerts';

export interface AlertSettings {
  /** 'once' | 'every' | 'bar' */
  repeat: string;
  expiryDays: number;
  cooldownSec: number;
}

/** Trigger count, cooldown and expiry of a new alert from Settings → Alerts. */
export function alertDefaults(
  o: AlertSettings,
  now = Date.now(),
): Pick<Alert, 'maxTriggers' | 'cooldownMs' | 'expiresAt'> {
  const cd = Math.max(0, o.cooldownSec) * 1000;
  return {
    maxTriggers: o.repeat === 'once' ? 1 : 0,
    // "Once per bar": at most one trigger per one-minute bar.
    cooldownMs: o.repeat === 'bar' ? Math.max(cd, 60_000) : cd,
    expiresAt: o.expiryDays > 0 ? now + o.expiryDays * 86_400_000 : null,
  };
}

/** True when another alert may be created under the Settings → Alerts limit. */
export function canAddAlert(count: number, maxActive: number): boolean {
  return count < Math.max(1, maxActive);
}

