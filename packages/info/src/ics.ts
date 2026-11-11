/** iCalendar (RFC 5545) parser for economic-calendar feeds: VEVENTs with impact / value fields. */

export type Impact = 'low' | 'medium' | 'high';

export interface CalendarEvent {
  uid: string;
  /** Start, epoch ms (UTC). */
  t: number;
  end?: number;
  allDay: boolean;
  title: string;
  description: string;
  /** ISO currency the event moves ('' when unknown). */
  currency: string;
  impact: Impact;
  actual?: string;
  forecast?: string;
  previous?: string;
  url?: string;
  categories: string[];
}

export interface IcsParseResult {
  calendarName: string;
  events: CalendarEvent[];
  /** Non-fatal problems (unknown time zone, unparsable date, …). */
  warnings: string[];
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Unfolds continuation lines (CRLF/LF followed by a space or tab). */
function unfold(src: string): string[] {
  return src
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

function parseLine(line: string): Prop | null {
  // NAME *(;PARAM=VALUE) : VALUE — colons inside quoted params do not end the name part.
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts[0] ?? '').trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** TEXT value unescaping: \n \N \, \; \\ */
export function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Common Windows zone names emitted by Outlook / Exchange calendars. */
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'China Standard Time': 'Asia/Shanghai',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  UTC: 'UTC',
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of an IANA zone from UTC at instant `t`. Throws RangeError for unknown zones. */
export function zoneOffset(t: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of dtf(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! % 24,
    parts.minute!,
    parts.second!,
  );
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Wall-clock time in a zone → UTC epoch ms (DST-aware, two-pass). */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = zoneOffset(guess, tz);
  let t = guess - o1;
  const o2 = zoneOffset(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const id = tzid.replace(/^\//, '').trim();
  const mapped = WINDOWS_ZONES[id] ?? id;
  try {
    dtf(mapped);
    return mapped;
  } catch {
    return null;
  }
}

/** Parses DATE / DATE-TIME values. `defaultTz` applies to floating times (no Z, no TZID). */
export function parseIcsDate(
  value: string,
  params: Record<string, string>,
  defaultTz: string,
  warnings?: string[],
): { t: number; allDay: boolean } | null {
  const v = value.trim();
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dm || params.VALUE === 'DATE') {
    if (!dm) return null;
    // All-day: midnight in the calendar's zone.
    const tz = resolveZone(params.TZID) ?? defaultTz;
    return { t: zonedToUtc(+dm[1]!, +dm[2]!, +dm[3]!, 0, 0, 0, tz), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const f = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)] as const;
  if (m[7]) return { t: Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]), allDay: false };
  let tz = defaultTz;
  if (params.TZID) {
    const z = resolveZone(params.TZID);
    if (z) tz = z;
    else warnings?.push(`Unknown time zone "${params.TZID}", using ${defaultTz}`);
  }
  return { t: zonedToUtc(...f, tz), allDay: false };
}

/** "PT1H30M", "P1D" → ms (negative durations allowed). */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    v.trim(),
  );
  if (!m) return null;
  const ms =
    (+(m[2] ?? 0) * 7 * 86_400 +
      +(m[3] ?? 0) * 86_400 +
      +(m[4] ?? 0) * 3600 +
      +(m[5] ?? 0) * 60 +
      +(m[6] ?? 0)) *
    1000;
  return m[1] === '-' ? -ms : ms;
}

/** Impact from free text: "high", "3", "★★★", "red", "medium", "low", "holiday" … */
export function parseImpact(raw: string | undefined): Impact | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^(3|h|red|★★★|\*\*\*)$/.test(s) || /\bhigh\b/.test(s)) return 'high';
  if (/^(2|med|m|orange|amber|★★|\*\*)$/.test(s) || /\b(medium|moderate)\b/.test(s))
    return 'medium';
  if (/^(1|0|l|yellow|gray|grey|★|\*|none|non-economic)$/.test(s) || /\b(low|holiday)\b/.test(s))
    return 'low';
  return null;
}

/** RFC 5545 PRIORITY: 1–4 high, 5 medium, 6–9 low, 0 undefined. */
function impactFromPriority(p: string | undefined): Impact | null {
  const n = Number(p);
  if (!p || !Number.isFinite(n) || n === 0) return null;
  return n <= 4 ? 'high' : n === 5 ? 'medium' : 'low';
}

const CURRENCIES = new Set([
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'NZD',
  'CNY',
  'CNH',
  'HKD',
  'SGD',
  'INR',
  'PKR',
  'SEK',
  'NOK',
  'MXN',
  'BRL',
  'ZAR',
  'TRY',
  'KRW',
  'ALL',
]);

const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD',
  'UNITED STATES': 'USD',
  EU: 'EUR',
  EZ: 'EUR',
  EMU: 'EUR',
  DE: 'EUR',
  GERMANY: 'EUR',
  FR: 'EUR',
  UK: 'GBP',
  GB: 'GBP',
  JP: 'JPY',
  JAPAN: 'JPY',
  CH: 'CHF',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  CN: 'CNY',
  CHINA: 'CNY',
};

function currencyFrom(raw: string | undefined): string {
  if (!raw) return '';
  const s = raw.trim().toUpperCase();
  if (CURRENCIES.has(s)) return s;
  return COUNTRY_CURRENCY[s] ?? '';
}

/** "USD - CPI m/m", "[EUR] ECB President speaks", "USD: NFP" → currency + clean title. */
export function splitCurrencyPrefix(summary: string): { currency: string; title: string } {
  const m = /^\s*[[(]?([A-Z]{3})[\])]?\s*[-:–|·]?\s+(.+)$/.exec(summary);
  if (m && CURRENCIES.has(m[1]!)) return { currency: m[1]!, title: m[2]!.trim() };
  return { currency: '', title: summary.trim() };
}

/** Pulls "Impact: High", "Actual: 3.1%", "Forecast: …", "Previous: …", "Currency: USD" out of descriptions. */
function fieldsFromDescription(desc: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /\b(impact|actual|forecast|consensus|previous|prior|currency|country)\s*[:=]\s*([^\n;|]+)/gi;
  for (const m of desc.matchAll(re)) {
    let k = m[1]!.toLowerCase();
    if (k === 'consensus') k = 'forecast';
    if (k === 'prior') k = 'previous';
    if (!(k in out)) out[k] = m[2]!.trim();
  }
  return out;
}

const valueOrUndef = (v: string | undefined) => {
  const s = v?.trim();
  return !s || s === '—' || s === '-' || s.toLowerCase() === 'n/a' ? undefined : s;
};

/**
 * Parses an .ics document. Supported: VEVENT (nested VALARM/VTIMEZONE skipped), DTSTART/DTEND with
 * UTC, TZID (IANA or common Windows names) or floating times, DURATION, SUMMARY, DESCRIPTION, UID,
 * URL, CATEGORIES, PRIORITY, STATUS:CANCELLED (dropped) and custom fields X-IMPACT /
 * X-HTFLOW-IMPACT, X-CURRENCY / X-COUNTRY, X-ACTUAL, X-FORECAST, X-PREVIOUS. RRULE is not expanded
 * (only the first occurrence is kept; a warning is added).
 */
export function parseIcs(src: string, opts: { defaultTz?: string } = {}): IcsParseResult {
  const warnings: string[] = [];
  const events: CalendarEvent[] = [];
  let calendarName = '';
  let defaultTz = opts.defaultTz ?? 'UTC';
  const stack: string[] = [];
  let cur: Prop[] | null = null;
  let rruleWarned = false;

  for (const line of unfold(src)) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT' && stack.length >= 1) cur = [];
      continue;
    }
    if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      const k = stack.lastIndexOf(comp);
      if (k >= 0) stack.length = k;
      if (comp === 'VEVENT' && cur) {
        const ev = buildEvent(cur, defaultTz, warnings);
        if (ev) events.push(ev);
        cur = null;
      }
      continue;
    }
    const inside = stack[stack.length - 1];
    if (inside === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') calendarName = unescapeText(p.value);
      if (p.name === 'X-WR-TIMEZONE') defaultTz = resolveZone(p.value) ?? defaultTz;
    } else if (inside === 'VEVENT' && cur) {
      if (p.name === 'RRULE' && !rruleWarned) {
        warnings.push(
          'Recurring events (RRULE) are not expanded; only the first occurrence is shown',
        );
        rruleWarned = true;
      }
      cur.push(p);
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { calendarName, events, warnings };
}

function buildEvent(props: Prop[], defaultTz: string, warnings: string[]): CalendarEvent | null {
  const get = (n: string) => props.find((p) => p.name === n);
  const text = (n: string) => {
    const p = get(n);
    return p ? unescapeText(p.value) : undefined;
  };
  if ((text('STATUS') ?? '').toUpperCase() === 'CANCELLED') return null;
  const ds = get('DTSTART');
  if (!ds) {
    warnings.push(`Event without DTSTART skipped (${text('SUMMARY') ?? 'untitled'})`);
    return null;
  }
  const start = parseIcsDate(ds.value, ds.params, defaultTz, warnings);
  if (!start) {
    warnings.push(`Unparsable DTSTART "${ds.value}"`);
    return null;
  }
  let end: number | undefined;
  const de = get('DTEND');
  if (de) end = parseIcsDate(de.value, de.params, defaultTz, warnings)?.t;
  else {
    const dur = text('DURATION');
    const ms = dur ? parseDuration(dur) : null;
    if (ms !== null) end = start.t + ms;
  }
  const rawSummary = text('SUMMARY') ?? '';
  const split = splitCurrencyPrefix(rawSummary);
  const description = text('DESCRIPTION') ?? '';
  const fromDesc = fieldsFromDescription(description);
  const categories = props
    .filter((p) => p.name === 'CATEGORIES')
    .flatMap((p) => p.value.split(/(?<!\\),/).map((c) => unescapeText(c).trim()))
    .filter(Boolean);
  const catImpact = categories.map((c) => parseImpact(c)).find((x) => x !== null) ?? null;
  const starImpact = /★★★|\(high\)/i.test(rawSummary)
    ? 'high'
    : /★★(?!★)|\(medium\)/i.test(rawSummary)
      ? 'medium'
      : null;
  const impact =
    parseImpact(text('X-HTFLOW-IMPACT')) ??
    parseImpact(text('X-IMPACT')) ??
    parseImpact(fromDesc.impact) ??
    impactFromPriority(text('PRIORITY')) ??
    catImpact ??
    starImpact ??
    'low';
  const currency =
    currencyFrom(text('X-CURRENCY')) ||
    currencyFrom(text('X-COUNTRY')) ||
    split.currency ||
    currencyFrom(fromDesc.currency) ||
    currencyFrom(fromDesc.country) ||
    categories.map(currencyFrom).find(Boolean) ||
    '';
  const title =
    split.title.replace(/\s*(★+|\((high|medium|low)\))\s*/gi, ' ').trim() || '(untitled)';
  const ev: CalendarEvent = {
    uid: text('UID')?.trim() || `${start.t}-${title}`,
    t: start.t,
    allDay: start.allDay,
    title,
    description,
    currency,
    impact,
    categories,
  };
  if (end !== undefined && Number.isFinite(end)) ev.end = end;
  const actual = valueOrUndef(text('X-ACTUAL') ?? fromDesc.actual);
  const forecast = valueOrUndef(text('X-FORECAST') ?? fromDesc.forecast);
  const previous = valueOrUndef(text('X-PREVIOUS') ?? fromDesc.previous);
  if (actual) ev.actual = actual;
  if (forecast) ev.forecast = forecast;
  if (previous) ev.previous = previous;
  const url = text('URL')?.trim();
  if (url) ev.url = url;
  return ev;
}
