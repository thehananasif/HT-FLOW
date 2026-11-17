import type { BarSpec } from './aggregator';

/**
 * Interval model behind the chart's timeframe menu: every listed interval (ticks, seconds,
 * minutes, hours, days, weeks, calendar months, volume, range) maps to one {@link BarSpec},
 * plus the pure period maths for weekly and calendar-month bars.
 *
 * Time zones: bars are bucketed in UTC. When the chart has an exchange session (RTH / ETH) the
 * aggregator buckets daily-and-longer bars from the session open instead, see `BarSeries`.
 */

export const SEC_MS = 1000;
export const MIN_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Duration used for a calendar month wherever only a nominal length is needed (30 days). */
export const MONTH_NOMINAL_MS = 30 * DAY_MS;
/** Monday 1970-01-05 00:00 UTC: weeks start on Monday. */
export const MONDAY_EPOCH_MS = 4 * DAY_MS;

// ------------------------------------------------------------------ period maths

/** Start (UTC, Monday 00:00) of the week bucket of `n` weeks that contains `ts`. */
export function weekStart(ts: number, n = 1): number {
  const len = Math.max(1, Math.round(n)) * WEEK_MS;
  return Math.floor((ts - MONDAY_EPOCH_MS) / len) * len + MONDAY_EPOCH_MS;
}

/** Months since January 1970 (UTC) of the month that contains `ts`. */
export function monthIndex(ts: number): number {
  const d = new Date(ts);
  return (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
}

/** First instant (UTC) of the month with this index. */
export function monthStartOf(index: number): number {
  const y = Math.floor(index / 12);
  return Date.UTC(1970 + y, index - y * 12, 1);
}

/**
 * Start of the calendar bucket of `n` months containing `ts`. Buckets are aligned to January 1970,
 * so 3 months = calendar quarters, 6 = half-years, 12 = calendar years.
 */
export function monthBucketStart(ts: number, n = 1): number {
  const len = Math.max(1, Math.round(n));
  return monthStartOf(Math.floor(monthIndex(ts) / len) * len);
}

/** First instant after the `n`-month bucket that starts at `start` (handles 28-31 day months). */
export function monthBucketEnd(start: number, n = 1): number {
  return monthStartOf(monthIndex(start) + Math.max(1, Math.round(n)));
}

/** UTC open time of the time bar (`ms`, optional calendar months) that contains `ts`. */
export function timeBucketStart(ts: number, ms: number, cal?: 'month'): number {
  if (cal === 'month') return monthBucketStart(ts, calendarMonths({ ms }));
  if (ms >= WEEK_MS && ms % WEEK_MS === 0) return weekStart(ts, ms / WEEK_MS);
  return Math.floor(ts / ms) * ms;
}

// ------------------------------------------------------------------ interval model

export type IntervalUnit =
  | 'tick'
  | 'second'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'volume'
  | 'range';

export interface Interval {
  unit: IntervalUnit;
  n: number;
}

/** Units offered by the "Add custom interval" dialog, in display order. */
export const INTERVAL_UNITS: { unit: IntervalUnit; label: string }[] = [
  { unit: 'tick', label: 'ticks' },
  { unit: 'second', label: 'seconds' },
  { unit: 'minute', label: 'minutes' },
  { unit: 'hour', label: 'hours' },
  { unit: 'day', label: 'days' },
  { unit: 'week', label: 'weeks' },
  { unit: 'month', label: 'months' },
  { unit: 'volume', label: 'volume' },
  { unit: 'range', label: 'range (ticks)' },
];

const MAX_TIME_MS = 3650 * DAY_MS;

const UNIT_MS: Partial<Record<IntervalUnit, number>> = {
  second: SEC_MS,
  minute: MIN_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: WEEK_MS,
};

/** Error text for an invalid interval, or null when it is valid. */
export function validateInterval(unit: IntervalUnit, n: number): string | null {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Enter a whole number.';
  if (n < 1) return 'The value must be at least 1.';
  switch (unit) {
    case 'tick':
      return n > 1_000_000 ? 'Tick bars go up to 1,000,000 ticks.' : null;
    case 'volume':
      return n > 1_000_000_000 ? 'Volume bars go up to 1,000,000,000.' : null;
    case 'range':
      return n > 10_000 ? 'Range bars go up to 10,000 ticks.' : null;
    case 'month':
      return n > 120 ? 'Calendar months go up to 120 (10 years).' : null;
    default:
      return n * UNIT_MS[unit]! > MAX_TIME_MS ? 'That is longer than 10 years.' : null;
  }
}

/** The bar spec of an interval (assumes it is valid). */
export function intervalToSpec({ unit, n }: Interval): BarSpec {
  switch (unit) {
    case 'tick':
      return { kind: 'tick', n };
    case 'volume':
      return { kind: 'volume', n };
    case 'range':
      return { kind: 'range', ticks: n };
    case 'month':
      return { kind: 'time', ms: n * MONTH_NOMINAL_MS, cal: 'month' };
    default:
      return { kind: 'time', ms: n * UNIT_MS[unit]! };
  }
}

/** Number of calendar months of a month-based time spec. */
export function calendarMonths(spec: { ms: number }): number {
  return Math.max(1, Math.round(spec.ms / MONTH_NOMINAL_MS));
}

/** Interval of a spec the menu can show (time, tick, volume, range), else null. */
export function specToInterval(spec: BarSpec): Interval | null {
  switch (spec.kind) {
    case 'tick':
      return { unit: 'tick', n: spec.n };
    case 'volume':
      return { unit: 'volume', n: spec.n };
    case 'range':
      return { unit: 'range', n: spec.ticks };
    case 'time': {
      if (spec.cal === 'month') return { unit: 'month', n: calendarMonths(spec) };
      const ms = spec.ms;
      if (ms % WEEK_MS === 0) return { unit: 'week', n: ms / WEEK_MS };
      if (ms % DAY_MS === 0) return { unit: 'day', n: ms / DAY_MS };
      if (ms % HOUR_MS === 0) return { unit: 'hour', n: ms / HOUR_MS };
      if (ms % MIN_MS === 0) return { unit: 'minute', n: ms / MIN_MS };
      return { unit: 'second', n: Math.max(1, Math.round(ms / SEC_MS)) };
    }
    default:
      return null;
  }
}

const NAMES: Record<IntervalUnit, [string, string]> = {
  tick: ['tick', 'ticks'],
  second: ['second', 'seconds'],
  minute: ['minute', 'minutes'],
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  volume: ['volume', 'volume'],
  range: ['range', 'range'],
};

/** Human name used by the menu and the Command Palette: "4 hours", "1 week", "3 months". */
export function intervalName(iv: Interval): string {
  if (iv.unit === 'volume') return `${iv.n} volume`;
  if (iv.unit === 'range') return `Range ${iv.n}`;
  return `${iv.n} ${NAMES[iv.unit][iv.n === 1 ? 0 : 1]}`;
}

// ------------------------------------------------------------------ typed input ("15", "4h", "1D")

const SUFFIX_WORDS: Record<string, IntervalUnit> = {
  tick: 'tick',
  ticks: 'tick',
  sec: 'second',
  secs: 'second',
  second: 'second',
  seconds: 'second',
  min: 'minute',
  mins: 'minute',
  minute: 'minute',
  minutes: 'minute',
  hour: 'hour',
  hours: 'hour',
  hr: 'hour',
  hrs: 'hour',
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  wk: 'week',
  mo: 'month',
  mon: 'month',
  month: 'month',
  months: 'month',
  year: 'month',
  years: 'month',
  vol: 'volume',
  volume: 'volume',
  range: 'range',
};

/** Single letters are case-sensitive only for m (minute) and M (month). */
const SUFFIX_LETTERS: Record<string, IntervalUnit> = {
  t: 'tick',
  s: 'second',
  m: 'minute',
  M: 'month',
  h: 'hour',
  d: 'day',
  w: 'week',
  y: 'month',
  v: 'volume',
  r: 'range',
};

export type ParsedInterval = { interval: Interval; spec: BarSpec } | { error: string };

/**
 * Parses quick interval input: a number with an optional unit. A bare number is minutes:
 * "15" = 15 minutes, "4h" = 4 hours, "1D" = 1 day, "2w" = 2 weeks, "3M" = 3 months,
 * "1000t" = 1000 ticks, "100v" = 100 volume, "8r" = range 8, "1y" = 12 months.
 */
export function parseInterval(text: string): ParsedInterval {
  const m = /^\s*(\d+)\s*([A-Za-z]*)\s*$/.exec(text);
  if (!m) return { error: 'Type a number and a unit, e.g. 15, 4h, 1D, 100t.' };
  let n = Number(m[1]);
  const raw = m[2]!;
  let unit: IntervalUnit | undefined;
  if (raw === '') unit = 'minute';
  else if (raw.length === 1) unit = SUFFIX_LETTERS[raw] ?? SUFFIX_LETTERS[raw.toLowerCase()];
  else unit = SUFFIX_WORDS[raw.toLowerCase()];
  if (!unit) return { error: `Unknown unit "${raw}". Use t, s, m, h, D, W, M, v or r.` };
  if (/^y(ears?)?$/i.test(raw)) n *= 12;
  const err = validateInterval(unit, n);
  if (err) return { error: err };
  const interval = { unit, n };
  return { interval, spec: intervalToSpec(interval) };
}

// ------------------------------------------------------------------ menu groups

export type IntervalGroupId = 'ticks' | 'seconds' | 'minutes' | 'hours' | 'days';

const time = (ms: number): BarSpec => ({ kind: 'time', ms });
const month = (n: number): BarSpec => ({ kind: 'time', ms: n * MONTH_NOMINAL_MS, cal: 'month' });

/** The default groups of the timeframe menu, in order. */
export const INTERVAL_GROUPS: { id: IntervalGroupId; label: string; specs: BarSpec[] }[] = [
  {
    id: 'ticks',
    label: 'Ticks',
    specs: [1, 10, 100, 1000].map((n): BarSpec => ({ kind: 'tick', n })),
  },
  {
    id: 'seconds',
    label: 'Seconds',
    specs: [1, 5, 10, 15, 30, 45].map((s) => time(s * SEC_MS)),
  },
  {
    id: 'minutes',
    label: 'Minutes',
    specs: [1, 2, 3, 5, 10, 15, 30, 45].map((m) => time(m * MIN_MS)),
  },
  { id: 'hours', label: 'Hours', specs: [1, 2, 3, 4, 6, 8, 12].map((h) => time(h * HOUR_MS)) },
  {
    id: 'days',
    label: 'Days',
    specs: [time(DAY_MS), time(WEEK_MS), month(1), month(3), month(6), month(12)],
  },
];

/** Menu group a time / tick spec belongs to (volume and range live in their own bar-type groups). */
export function groupOfSpec(spec: BarSpec): IntervalGroupId | null {
  const iv = specToInterval(spec);
  if (!iv) return null;
  switch (iv.unit) {
    case 'tick':
      return 'ticks';
    case 'second':
      return 'seconds';
    case 'minute':
      return 'minutes';
    case 'hour':
      return 'hours';
    case 'day':
    case 'week':
    case 'month':
      return 'days';
    default:
      return null;
  }
}
