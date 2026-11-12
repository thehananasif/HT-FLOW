import { hhmm, inSession, localClock } from './sessions';
import type { SessionSpec } from './types';

/** Session choice for bars: catalog RTH / ETH, or a custom exchange-local window. */
export type SessionChoice =
  'rth' | 'eth' | { open: string; close: string; tz?: string; days?: number[] };

export interface ResolvedSessionRules {
  id: string;
  inSession(ts: number): boolean;
  sessionStart(ts: number): number;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const MIN = 60_000;

/** True when a session never closes (crypto 24/7: open == close every day, no breaks). */
export function isAllDay(s: SessionSpec): boolean {
  return hhmm(s.open) === hhmm(s.close) && s.days.length === 7 && !s.breaks?.length;
}

/**
 * Turns catalog sessions into bar-builder rules (P07). Returns null for "no filter": 24/7
 * instruments (crypto), or an RTH request on an instrument that has none.
 * Lookups are cached per minute so 1M+ trades stay cheap.
 */
export function sessionRules(
  sessions: readonly SessionSpec[],
  choice: SessionChoice,
): ResolvedSessionRules | null {
  let spec: SessionSpec | undefined;
  if (choice === 'rth') spec = sessions.find((s) => s.name === 'RTH');
  else if (choice === 'eth') spec = sessions.find((s) => s.name === 'ETH') ?? sessions[0];
  else {
    if (!/^\d\d?:\d\d$/.test(choice.open) || !/^\d\d?:\d\d$/.test(choice.close)) return null;
    spec = {
      name: 'RTH',
      tz: choice.tz ?? sessions[0]?.tz ?? 'UTC',
      open: choice.open,
      close: choice.close,
      days: choice.days?.length ? choice.days : ALL_DAYS,
    };
  }
  if (!spec || isAllDay(spec)) return null;
  const s = spec;
  const open = hhmm(s.open);
  let inMin = Number.NaN;
  let inVal = false;
  let stMin = Number.NaN;
  let stVal = 0;
  const id = typeof choice === 'string' ? choice : `custom ${choice.open}-${choice.close} ${s.tz}`;
  return {
    id,
    inSession(ts) {
      const m = Math.floor(ts / MIN);
      if (m !== inMin) {
        inMin = m;
        inVal = inSession(s, ts);
      }
      return inVal;
    },
    sessionStart(ts) {
      const m = Math.floor(ts / MIN);
      if (m !== stMin) {
        stMin = m;
        const { minutes } = localClock(ts, s.tz);
        const back = minutes >= open ? minutes - open : minutes + 1440 - open;
        stVal = (m - back) * MIN;
      }
      return stVal;
    },
  };
}
