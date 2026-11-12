/**
 * Date / time formatting driven by Settings → General (date format, 24-hour clock) and
 * Settings → Time zones (application zone). Tables, the journal, the tape and the activity log
 * all format times through here so one setting changes every one of them.
 *
 * The pure functions take their options explicitly (tested); the `fmt*` wrappers read the stored
 * settings. Components that call a wrapper while rendering should call `useTimeFormat()` once so
 * they re-render when one of those settings changes.
 */
import { getSetting, isValidTimeZone, useSetting, type SettingsValues } from './settings';

export type DateFormat = SettingsValues['general.dateFormat'];

export interface TimeFormatOptions {
  /** IANA zone; invalid or empty falls back to UTC. */
  zone: string;
  dateFormat: DateFormat;
  clock24h: boolean;
}

interface Parts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

const dtf = new Map<string, Intl.DateTimeFormat>();

function partsOf(ts: number, zone: string): Parts {
  const z = isValidTimeZone(zone) ? zone : 'UTC';
  let f = dtf.get(z);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: z,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtf.set(z, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(ts)) out[p.type] = p.value;
  return {
    year: out.year ?? '0000',
    month: out.month ?? '01',
    day: out.day ?? '01',
    hour: out.hour === '24' ? '00' : (out.hour ?? '00'),
    minute: out.minute ?? '00',
    second: out.second ?? '00',
  };
}

export function formatDate(ts: number, o: TimeFormatOptions): string {
  const p = partsOf(ts, o.zone);
  switch (o.dateFormat) {
    case 'DD.MM.YYYY':
      return `${p.day}.${p.month}.${p.year}`;
    case 'DD/MM/YYYY':
      return `${p.day}/${p.month}/${p.year}`;
    case 'MM/DD/YYYY':
      return `${p.month}/${p.day}/${p.year}`;
    default:
      return `${p.year}-${p.month}-${p.day}`;
  }
}

/** "14:30:05" / "2:30:05 PM"; `ms` appends ".123" (taken from the timestamp). */
export function formatClock(
  ts: number,
  o: TimeFormatOptions,
  opts: { seconds?: boolean; ms?: boolean } = {},
): string {
  const p = partsOf(ts, o.zone);
  const seconds = opts.seconds ?? true;
  const h = Number(p.hour);
  const hh = o.clock24h ? p.hour : String(h % 12 === 0 ? 12 : h % 12);
  let s = `${hh}:${p.minute}`;
  if (seconds) s += `:${p.second}`;
  if (seconds && opts.ms)
    s += '.' + String(Math.floor(((ts % 1000) + 1000) % 1000)).padStart(3, '0');
  if (!o.clock24h) s += h >= 12 ? ' PM' : ' AM';
  return s;
}

export function formatDateTime(
  ts: number,
  o: TimeFormatOptions,
  opts: { seconds?: boolean; ms?: boolean } = {},
): string {
  return `${formatDate(ts, o)} ${formatClock(ts, o, opts)}`;
}

/** Options from the stored settings. */
export function timeFormatOptions(): TimeFormatOptions {
  return {
    zone: getSetting('timezones.app'),
    dateFormat: getSetting('general.dateFormat'),
    clock24h: getSetting('general.clock24h'),
  };
}

export const fmtDate = (ts: number): string => formatDate(ts, timeFormatOptions());
export const fmtClock = (ts: number, opts?: { seconds?: boolean; ms?: boolean }): string =>
  formatClock(ts, timeFormatOptions(), opts);
export const fmtDateTime = (ts: number, opts?: { seconds?: boolean; ms?: boolean }): string =>
  formatDateTime(ts, timeFormatOptions(), opts);

/** Subscribes a component to the settings the wrappers above read. */
export function useTimeFormat(): TimeFormatOptions {
  const zone = useSetting('timezones.app');
  const dateFormat = useSetting('general.dateFormat');
  const clock24h = useSetting('general.clock24h');
  return { zone, dateFormat, clock24h };
}
