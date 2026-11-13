/** Timestamp parsing shared by the CSV importer and the Custom WebSocket mapping (pure, no Date locale). */

export type TimeFormat = 'auto' | 'iso' | 'epoch-s' | 'epoch-ms' | 'epoch-us' | 'epoch-ns';
/** 'utc', 'local' (this PC) or a fixed offset in minutes east of UTC, used when the text has no zone. */
export type TimeZoneSpec = 'utc' | 'local' | number;
export type DateOrder = 'ymd' | 'dmy' | 'mdy';

export const TIME_FORMATS: { value: TimeFormat; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'iso', label: 'ISO 8601 / date text' },
  { value: 'epoch-s', label: 'Epoch seconds' },
  { value: 'epoch-ms', label: 'Epoch milliseconds' },
  { value: 'epoch-us', label: 'Epoch microseconds' },
  { value: 'epoch-ns', label: 'Epoch nanoseconds' },
];

type EpochUnit = 'epoch-s' | 'epoch-ms' | 'epoch-us' | 'epoch-ns';

const UNIT_MS: Record<EpochUnit, number> = {
  'epoch-s': 1000,
  'epoch-ms': 1,
  'epoch-us': 1 / 1000,
  'epoch-ns': 1 / 1e6,
};

/** Epoch unit by magnitude (10 digits = s, 13 = ms, 16 = us, 19 = ns). */
export function epochUnitOf(v: number): EpochUnit {
  const a = Math.abs(v);
  if (a < 1e11) return 'epoch-s';
  if (a < 1e14) return 'epoch-ms';
  if (a < 1e17) return 'epoch-us';
  return 'epoch-ns';
}

const NUM = /^[+-]?\d+(\.\d+)?$/;
const DATE =
  /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** True when the text is a plain number (candidate epoch). */
export const isNumeric = (s: string) => NUM.test(s.trim());

function zoned(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  tz: TimeZoneSpec,
): number {
  if (tz === 'local') return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  return typeof tz === 'number' ? utc - tz * 60_000 : utc;
}

/** Parses a date/time text. Returns epoch ms (fractional allowed) or null. */
export function parseDateText(
  raw: string,
  tz: TimeZoneSpec,
  order: DateOrder = 'ymd',
): number | null {
  const m = DATE.exec(raw.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  let y: number, mo: number, d: number;
  if (m[1]!.length === 4) {
    y = a;
    mo = b;
    d = c;
  } else if (m[3]!.length === 4) {
    y = c;
    if (order === 'mdy') {
      mo = a;
      d = b;
    } else {
      d = a;
      mo = b;
    }
  } else return null;
  const h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  let zone: TimeZoneSpec = tz;
  const z = m[8];
  if (z) {
    if (z.toUpperCase() === 'Z') zone = 0;
    else {
      const sign = z.startsWith('-') ? -1 : 1;
      const digits = z.slice(1).replace(':', '');
      zone = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0));
    }
  }
  const whole = Math.floor(frac);
  return zoned(y, mo, d, h, mi, s, whole, zone) + (frac - whole);
}

/** Parses one cell. Returns epoch ms or null when it does not fit the chosen format. */
export function parseTime(
  raw: string,
  fmt: TimeFormat,
  tz: TimeZoneSpec = 'utc',
  order: DateOrder = 'ymd',
): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (fmt === 'iso') return parseDateText(s, tz, order);
  if (isNumeric(s)) {
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    const unit: EpochUnit = fmt === 'auto' ? epochUnitOf(v) : fmt;
    const ms = v * UNIT_MS[unit];
    return ms > 0 && ms < 1e14 ? ms : null;
  }
  return fmt === 'auto' ? parseDateText(s, tz, order) : null;
}

/** Best format for a set of sample cells (all must parse). */
export function detectTimeFormat(samples: readonly string[]): TimeFormat {
  const cells = samples.map((x) => x.trim()).filter(Boolean);
  if (!cells.length) return 'auto';
  if (cells.every(isNumeric)) {
    const units = new Set(cells.map((x) => epochUnitOf(Number(x))));
    return units.size === 1 ? [...units][0]! : 'auto';
  }
  return cells.every((x) => parseDateText(x, 'utc') !== null) ? 'iso' : 'auto';
}

export function parseTimeZone(text: string): TimeZoneSpec | null {
  const t = text.trim().toLowerCase();
  if (t === 'utc' || t === 'z' || t === 'gmt') return 'utc';
  if (t === 'local') return 'local';
  const m = /^(?:utc)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3] ?? 0);
  if (hh > 14 || mm > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (hh * 60 + mm);
}

export const formatTimeZone = (tz: TimeZoneSpec): string =>
  tz === 'utc' || tz === 'local'
    ? tz
    : `UTC${tz < 0 ? '-' : '+'}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, '0')}:${String(Math.abs(tz) % 60).padStart(2, '0')}`;
