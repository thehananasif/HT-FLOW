/**
 * Price levels in model text. A number that looks like a price (decimal, thousands separator or
 * at least three digits) and is plausible against the instrument's last price becomes a clickable
 * chip in the chat. Pure text processing: the result is rendered with React elements only.
 */
export interface LevelMatch {
  /** Offsets into the source text. */
  start: number;
  end: number;
  /** The text as written (e.g. "64,250.5" or "$64250"). */
  text: string;
  value: number;
}

export type LevelPart = string | LevelMatch;

export interface LevelOptions {
  /** Last price of the active instrument; numbers far from it are not levels. */
  ref?: number | null;
  /** Accept values within [ref / maxRatio, ref * maxRatio]. Default 2. */
  maxRatio?: number;
}

const NUM = /(?<![\w.,])(\$?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w%]|[.,]\d)/g;

const isYear = (v: number, raw: string) => /^\d{4}$/.test(raw) && v >= 1900 && v <= 2100;

export function detectLevels(text: string, opts: LevelOptions = {}): LevelMatch[] {
  const out: LevelMatch[] = [];
  const ratio = opts.maxRatio ?? 2;
  const ref = opts.ref && opts.ref > 0 ? opts.ref : null;
  for (const m of text.matchAll(NUM)) {
    const raw = m[2]!;
    const value = Number(raw.replaceAll(',', ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const decimal = raw.includes('.');
    const grouped = raw.includes(',');
    const digits = raw.replace(/[.,].*$/, '').length;
    if (!decimal && !grouped && digits < 3) continue;
    if (ref) {
      if (value < ref / ratio || value > ref * ratio) continue;
    } else if (!decimal && !grouped && isYear(value, raw)) continue;
    const start = m.index!;
    out.push({ start, end: start + m[0].length, text: m[0], value });
  }
  return out;
}

/** Text split into plain strings and level matches, in order. */
export function splitLevels(text: string, opts: LevelOptions = {}): LevelPart[] {
  const found = detectLevels(text, opts);
  if (!found.length) return [text];
  const parts: LevelPart[] = [];
  let at = 0;
  for (const f of found) {
    if (f.start > at) parts.push(text.slice(at, f.start));
    parts.push(f);
    at = f.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** Alert direction for a level: crossing upward when the level is above the last price. */
export function alertDirection(level: number, last: number | null | undefined): 'up' | 'down' {
  return last === null || last === undefined || level >= last ? 'up' : 'down';
}
