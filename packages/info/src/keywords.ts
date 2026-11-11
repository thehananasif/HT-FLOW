export interface Segment {
  text: string;
  /** The keyword (as configured) this segment matched, if any. */
  keyword?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cleans a user keyword list: trims, drops empties and case-insensitive duplicates. */
export function normalizeKeywords(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of list) {
    const t = k.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function buildRe(keywords: readonly string[]): RegExp | null {
  const ks = normalizeKeywords(keywords).sort((a, b) => b.length - a.length);
  if (!ks.length) return null;
  // Word boundaries on the alphanumeric ends of each keyword ("rate" ≠ "separate", "S&P" works).
  const parts = ks.map((k) => {
    const pre = /^\w/.test(k) ? '(?<![\\w])' : '';
    const post = /\w$/.test(k) ? '(?![\\w])' : '';
    return `${pre}${escapeRe(k)}${post}`;
  });
  return new RegExp(parts.join('|'), 'giu');
}

/** Splits text into plain and keyword segments (case-insensitive, whole words, longest first). */
export function highlightSegments(text: string, keywords: readonly string[]): Segment[] {
  const re = buildRe(keywords);
  if (!re || !text) return text ? [{ text }] : [];
  const lookup = new Map(normalizeKeywords(keywords).map((k) => [k.toLowerCase(), k]));
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: m[0], keyword: lookup.get(m[0].toLowerCase()) ?? m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Keywords (as configured) found in any of the texts. */
export function matchKeywords(texts: readonly string[], keywords: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of texts)
    for (const s of highlightSegments(t, keywords)) if (s.keyword) found.add(s.keyword);
  return [...found];
}
