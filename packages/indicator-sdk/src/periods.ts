import type { TimeframeId } from './types';

const MIN = 60_000;
const DAY = 86_400_000;

const INTRADAY: Partial<Record<TimeframeId, number>> = {
  M1: MIN,
  M5: 5 * MIN,
  M15: 15 * MIN,
  M30: 30 * MIN,
  H1: 60 * MIN,
  H4: 240 * MIN,
};

/**
 * Start (epoch ms, UTC) of the period containing t. Days are UTC sessions (24 h crypto default);
 * weeks start Monday 00:00 UTC; months on the 1st. 'chart' returns t itself.
 */
export function periodStart(t: number, tf: TimeframeId): number {
  if (tf === 'chart') return t;
  const ms = INTRADAY[tf];
  if (ms) return Math.floor(t / ms) * ms;
  const day = Math.floor(t / DAY) * DAY;
  if (tf === 'D') return day;
  if (tf === 'W') {
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    return day - dow * DAY;
  }
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Reset modes shared by cumulative indicators (CVD, VWAP, …). */
export type ResetMode = 'session' | 'week' | 'month' | 'never';

export const RESET_OPTIONS = [
  ['session', 'Session (day)'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['never', 'Never'],
] as const;

/** True when bar time t starts a new reset period relative to the previous bar time. */
export function isNewPeriod(prevT: number, t: number, mode: ResetMode): boolean {
  if (Number.isNaN(prevT)) return true;
  if (mode === 'never') return false;
  const tf: TimeframeId = mode === 'session' ? 'D' : mode === 'week' ? 'W' : 'MN';
  return periodStart(prevT, tf) !== periodStart(t, tf);
}

export function resetTimeframe(mode: ResetMode): TimeframeId {
  return mode === 'session' ? 'D' : mode === 'week' ? 'W' : mode === 'month' ? 'MN' : 'chart';
}

/** Chart timeframe classes for the Visibility tab. */
export type TfClass =
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'days'
  | 'tick'
  | 'volume'
  | 'delta'
  | 'range';

export const TF_CLASSES: { value: TfClass; label: string }[] = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days and above' },
  { value: 'tick', label: 'Tick bars' },
  { value: 'volume', label: 'Volume bars' },
  { value: 'delta', label: 'Delta bars' },
  { value: 'range', label: 'Range bars' },
];

export function tfClassOf(
  spec:
    | { kind: 'time'; ms: number }
    | { kind: 'tick' | 'volume' | 'delta'; n: number }
    | { kind: 'range'; ticks: number },
): TfClass {
  if (spec.kind !== 'time') return spec.kind;
  if (spec.ms < MIN) return 'seconds';
  if (spec.ms < 60 * MIN) return 'minutes';
  if (spec.ms < DAY) return 'hours';
  return 'days';
}
