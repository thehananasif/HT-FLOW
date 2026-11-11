import { decodeEntities } from './xml';

/** HTML → plain text for summaries: drops scripts/styles/tags, decodes entities, collapses spaces. */
export function stripHtml(html: string): string {
  let s = html
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

const TZ_ABBR: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -5,
  EDT: -4,
  CST: -6,
  CDT: -5,
  MST: -7,
  MDT: -6,
  PST: -8,
  PDT: -7,
  CET: 1,
  CEST: 2,
  BST: 1,
  JST: 9,
  HKT: 8,
  SGT: 8,
  AEST: 10,
  AEDT: 11,
  IST: 5.5,
  PKT: 5,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function offsetMinutes(tz: string | undefined): number | null {
  if (!tz) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const h = TZ_ABBR[tz.toUpperCase()];
  return h === undefined ? null : h * 60;
}

/**
 * Feed dates: RFC 822/1123 (`Wed, 04 Nov 2026 13:45:00 GMT`, 2-digit years, named zones),
 * ISO 8601 / RFC 3339 (`2026-11-04T13:45:00Z`, `+05:00`, fractional seconds, date only).
 * Returns epoch ms or null.
 */
export function parseFeedDate(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(
    s,
  );
  if (m) {
    const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
    const off = offsetMinutes(m[8]?.toUpperCase());
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms);
    return Number.isFinite(t) ? t - (off ?? 0) * 60_000 : null;
  }
  m =
    /^(?:[a-z]{3,9},?\s+)?(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([a-z]{1,5}|[+-]\d{2}:?\d{2})?/i.exec(
      s,
    );
  if (m) {
    const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    let year = Number(m[3]);
    if (m[3]!.length === 2) year += year < 50 ? 2000 : 1900;
    const off = offsetMinutes(m[7]);
    if (mon >= 0 && off !== null) {
      const t = Date.UTC(year, mon, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
      return t - off * 60_000;
    }
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Stable 32-bit FNV-1a hash as base36 (ids for items without guid/link). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
