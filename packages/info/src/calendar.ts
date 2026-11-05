import type { CalendarEvent, Impact } from './ics';

export const IMPACT_RANK: Record<Impact, number> = { low: 1, medium: 2, high: 3 };

export type ImpactFilter = 'all' | 'medium' | 'high';

export function passesImpact(e: Pick<CalendarEvent, 'impact'>, f: ImpactFilter): boolean {
  if (f === 'all') return true;
  return IMPACT_RANK[e.impact] >= (f === 'high' ? 3 : 2);
}

/** Next high-impact event at or after `now` (events need not be sorted). */
export function nextHighImpact<T extends CalendarEvent>(events: readonly T[], now: number): T | null {
  let best: T | null = null;
  for (const e of events) {
    if (e.impact !== 'high' || e.allDay || e.t < now) continue;
    if (!best || e.t < best.t) best = e;
  }
  return best;
}

/** "2d 4h", "20h 44m", "12m 05s", "45s"; "now" for ≤ 0. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

const dayFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, key: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${tz}|${key}`;
  let f = dayFmt.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...o, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' });
    }
    dayFmt.set(k, f);
  }
  return f;
}

/** YYYY-MM-DD of an instant in a zone. */
export function dayKey(t: number, tz: string): string {
  const p = fmt(tz, 'key', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t);
  const g = (ty: string) => p.find((x) => x.type === ty)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** "Thu 05 Nov" */
export function dayLabel(t: number, tz: string): string {
  return fmt(tz, 'label', { weekday: 'short', day: '2-digit', month: 'short' })
    .format(t)
    .replace(',', '');
}

/** "17:30" in the zone. */
export function timeLabel(t: number, tz: string): string {
  return fmt(tz, 'time', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
}

/** "UTC+5", "UTC-4", "UTC+5:30" for the zone at instant t. */
export function utcOffsetLabel(t: number, tz: string): string {
  const p = fmt(tz, 'off', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(t);
  const g = (ty: string) => Number(p.find((x) => x.type === ty)?.value ?? 0);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  const off = Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60_000);
  if (off === 0) return 'UTC';
  const sign = off > 0 ? '+' : '-';
  const a = Math.abs(off);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

export interface DayGroup<T> {
  key: string;
  label: string;
  events: T[];
}

/** Groups (sorted) events by calendar day in the user's zone. */
export function groupByDay<T extends CalendarEvent>(events: readonly T[], tz: string): DayGroup<T>[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const out: DayGroup<T>[] = [];
  for (const e of sorted) {
    const key = dayKey(e.t, tz);
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(e.t, tz), events: [] };
      out.push(g);
    }
    g.events.push(e);
  }
  return out;
}

/** "3.1%", "-1.2M", "221K", "54.9", "1,250" → number (suffix-scaled), or null. */
export function parseEconValue(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([+-]?)\s*([\d,]*\.?\d+)\s*([kmbt%]?)\s*$/i.exec(v.replace(/[<>≈~]/g, ''));
  if (!m) return null;
  let n = Number(m[2]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (m[1] === '-') n = -n;
  const mult: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  return n * (mult[m[3]!.toLowerCase()] ?? 1);
}

/** Events where a lower print is the better outcome for the currency. */
const LOWER_IS_BETTER = /unemployment|jobless|claims|inventories|deficit/i;

/** 'up' (green) when the actual beats the forecast for the currency, 'down' (red) when it misses. */
export function surprise(e: Pick<CalendarEvent, 'title' | 'actual' | 'forecast'>): 'up' | 'down' | null {
  const a = parseEconValue(e.actual);
  const f = parseEconValue(e.forecast);
  if (a === null || f === null || a === f) return null;
  const better = LOWER_IS_BETTER.test(e.title) ? a < f : a > f;
  return better ? 'up' : 'down';
}

/**
 * Events whose "alert N min before" moment is due: now ∈ [t − N min, t) and not fired yet.
 * `fired` holds keys already alerted (uid + t) and is updated in place.
 */
export function dueAlerts<T extends CalendarEvent>(
  events: readonly T[],
  now: number,
  minutesBefore: number,
  minImpact: ImpactFilter,
  fired: Set<string>,
): T[] {
  const lead = Math.max(0, minutesBefore) * 60_000;
  const out: T[] = [];
  for (const e of events) {
    if (e.allDay || !passesImpact(e, minImpact)) continue;
    const key = `${e.uid}@${e.t}`;
    if (fired.has(key)) continue;
    if (now >= e.t - lead && now < e.t) {
      fired.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Merges events from several sources; the same uid + start keeps the first occurrence. */
export function mergeEvents<T extends CalendarEvent>(lists: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const l of lists)
    for (const e of l) {
      const k = `${e.uid}@${e.t}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  return out.sort((a, b) => a.t - b.t);
}

const pad = (n: number) => String(n).padStart(2, '0');
const icsUtc = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};

/** Sample schedule: [offset hours from the anchor, currency, impact, title, forecast, previous, actual?]. */
const SAMPLE: [number, string, Impact, string, string, string, string?][] = [
  [-20, 'USD', 'medium', 'Factory Orders m/m', '0.4%', '0.2%', '0.6%'],
  [-9, 'EUR', 'medium', 'Retail Sales m/m', '0.2%', '-0.1%', '0.1%'],
  [-5, 'USD', 'high', 'ADP Non-Farm Employment Change', '135K', '128K', '142K'],
  [-2, 'USD', 'high', 'ISM Services PMI', '53.8', '54.1', '52.9'],
  [3, 'USD', 'high', 'Initial Jobless Claims', '221K', '218K'],
  [4, 'EUR', 'medium', 'ECB President Speaks', '', ''],
  [5, 'USD', 'medium', 'S&P Global Services PMI', '54.9', '55.2'],
  [7, 'USD', 'high', 'Crude Oil Inventories', '-1.2M', '0.8M'],
  [26, 'USD', 'high', 'Non-Farm Employment Change', '160K', '142K'],
  [26, 'USD', 'high', 'Unemployment Rate', '4.2%', '4.2%'],
  [30, 'CAD', 'medium', 'Employment Change', '15.0K', '22.1K'],
  [50, 'GBP', 'low', 'Halifax HPI m/m', '0.3%', '0.4%'],
  [74, 'CNY', 'medium', 'CPI y/y', '0.4%', '0.3%'],
  [98, 'USD', 'high', 'CPI m/m', '0.3%', '0.2%'],
  [99, 'USD', 'high', 'FOMC Member Speaks', '', ''],
  [122, 'JPY', 'medium', 'BoJ Summary of Opinions', '', ''],
  [146, 'AUD', 'medium', 'RBA Monetary Policy Statement', '', ''],
];

/**
 * Bundled SAMPLE calendar as .ics text, anchored to the current hour so it always shows a few
 * past and upcoming events. Every title ends in "(sample)" and the calendar is named
 * "HT Flow sample calendar" — these are NOT real release times or values.
 */
export function sampleCalendarIcs(now: number): string {
  const anchor = Math.floor(now / 3_600_000) * 3_600_000 + 30 * 60_000;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HT Flow//Sample calendar//EN',
    'X-WR-CALNAME:HT Flow sample calendar',
  ];
  SAMPLE.forEach(([h, cur, impact, title, fc, prev, actual], i) => {
    const t = anchor + h * 3_600_000;
    lines.push(
      'BEGIN:VEVENT',
      `UID:sample-${i}@htflow.local`,
      `DTSTART:${icsUtc(t)}`,
      `SUMMARY:${cur} - ${title} (sample)`,
      `X-IMPACT:${impact}`,
      `X-CURRENCY:${cur}`,
      ...(fc ? [`X-FORECAST:${fc}`] : []),
      ...(prev ? [`X-PREVIOUS:${prev}`] : []),
      ...(actual && h < 0 ? [`X-ACTUAL:${actual}`] : []),
      'DESCRIPTION:Sample event bundled with HT Flow for offline use. Not a real release time.',
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
