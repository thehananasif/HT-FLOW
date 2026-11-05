import type { SessionSpec } from './types';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Local weekday (0 = Sunday) and minutes after midnight of `ts` in `tz`. */
export function localClock(ts: number, tz: string): { weekday: number; minutes: number } {
  let weekday = 0;
  let h = 0;
  let m = 0;
  for (const p of formatter(tz).formatToParts(ts)) {
    if (p.type === 'weekday') weekday = WEEKDAYS[p.value] ?? 0;
    else if (p.type === 'hour') h = Number(p.value) % 24;
    else if (p.type === 'minute') m = Number(p.value);
  }
  return { weekday, minutes: h * 60 + m };
}

export function hhmm(s: string): number {
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m ?? 0);
}

/** True when `ts` falls inside the session (breaks excluded). */
export function inSession(s: SessionSpec, ts: number): boolean {
  const { weekday, minutes } = localClock(ts, s.tz);
  const o = hhmm(s.open);
  const c = hhmm(s.close);
  const prev = (weekday + 6) % 7;
  let open: boolean;
  if (c > o) open = s.days.includes(weekday) && minutes >= o && minutes < c;
  else
    open =
      (s.days.includes(weekday) && minutes >= o) || (s.days.includes(prev) && minutes < c);
  if (!open) return false;
  for (const b of s.breaks ?? []) {
    if (minutes >= hhmm(b.from) && minutes < hhmm(b.to)) return false;
  }
  return true;
}

/** Which session is trading at `ts`: RTH wins over ETH; null = closed. */
export function sessionAt(sessions: SessionSpec[], ts: number): 'RTH' | 'ETH' | null {
  const rth = sessions.find((s) => s.name === 'RTH');
  if (rth && inSession(rth, ts)) return 'RTH';
  const eth = sessions.find((s) => s.name === 'ETH');
  if (eth && inSession(eth, ts)) return 'ETH';
  return null;
}

/** "08:30–15:00 CT" style label for tooltips. */
export function sessionLabel(s: SessionSpec): string {
  const zone = s.tz.split('/').pop()?.replace(/_/g, ' ') ?? s.tz;
  const allDay = s.open === s.close && s.days.length === 7;
  return allDay ? `24/7 (${zone})` : `${s.open}–${s.close} ${zone}`;
}
