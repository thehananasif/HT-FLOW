/**
 * Ranked, typo-tolerant search over symbol / root / name / exchange / aliases (P04 picker).
 * Designed for 10k+ entries in well under 50 ms: fields are pre-lowercased and tokenised once,
 * fuzzy matching runs only on tokens that survive a cheap character-set filter.
 */
export interface SearchDoc {
  id: string;
  symbol: string;
  root: string;
  name: string;
  exchange: string;
  aliases?: string[];
}

interface Token {
  text: string;
  mask: number;
  /** Field weight multiplier (symbol tokens rank above name tokens). */
  w: number;
}

interface Prepared<T> {
  doc: T;
  symbol: string;
  compact: string;
  root: string;
  name: string;
  exchange: string;
  tokens: Token[];
  /** Union of every character-set mask of the entry: a cheap whole-entry reject. */
  mask: number;
}

export interface SearchHit<T> {
  doc: T;
  score: number;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const compactOf = (s: string) => s.replace(/[^a-z0-9]/g, '');

function maskOf(s: string): number {
  let m = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) m |= 1 << (c - 97);
    else if (c >= 48 && c <= 57) m |= 1 << (26 + ((c - 48) % 6));
  }
  return m;
}

function popcount(x: number): number {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

const rowA = new Int32Array(64);
const rowB = new Int32Array(64);
const rowC = new Int32Array(64);

/** Optimal-string-alignment (Damerau) distance, abandoned once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la > 60 || lb > 60) return max + 1;
  let prev2 = rowA;
  let prev = rowB;
  let cur = rowC;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb)
        v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb]!;
}

export class SearchIndex<T extends SearchDoc> {
  private items: Prepared<T>[];

  constructor(docs: readonly T[]) {
    this.items = docs.map((doc) => {
      const symbol = norm(doc.symbol);
      const name = norm(doc.name);
      const tokens: Token[] = [];
      const add = (s: string, w: number) => {
        for (const t of s.split(/[^a-z0-9]+/)) if (t) tokens.push({ text: t, mask: maskOf(t), w });
      };
      add(symbol, 1.2);
      add(norm(doc.root), 1.1);
      add(name, 1);
      for (const a of doc.aliases ?? []) add(norm(a), 0.9);
      let mask = maskOf(symbol) | maskOf(name) | maskOf(norm(doc.exchange));
      for (const t of tokens) mask |= t.mask;
      return {
        mask,
        doc,
        symbol,
        compact: compactOf(symbol),
        root: norm(doc.root),
        name,
        exchange: norm(doc.exchange),
        tokens,
      };
    });
  }

  get size(): number {
    return this.items.length;
  }

  /** Scores one term against one entry; 0 = no match. */
  private termScore(p: Prepared<T>, term: string, tMask: number): number {
    if (p.symbol === term || p.compact === term) return 1000;
    if (p.root === term) return 900;
    if (p.symbol.startsWith(term) || p.compact.startsWith(term))
      return 760 - Math.min(60, p.symbol.length - term.length);
    if (p.root.startsWith(term)) return 640;
    let best = 0;
    for (const t of p.tokens) {
      if (t.text === term) best = Math.max(best, 560 * t.w);
      else if (t.text.startsWith(term))
        best = Math.max(best, (440 - (t.text.length - term.length)) * t.w);
    }
    if (best) return best;
    if (p.exchange === term) return 320;
    if (p.exchange.startsWith(term)) return 260;
    if (term.length >= 3 && (p.name.includes(term) || p.symbol.includes(term))) return 240;
    if (term.length < 3) return 0;
    // Typo tolerance: 1 edit for 3–6 chars, 2 edits from 7 chars.
    const max = term.length >= 7 ? 2 : 1;
    for (const t of p.tokens) {
      if (popcount(tMask & ~t.mask) > max) continue;
      let d = editDistance(term, t.text, max);
      if (d > max && t.text.length > term.length)
        d = editDistance(term, t.text.slice(0, term.length), max);
      if (d <= max) best = Math.max(best, (180 - d * 50) * t.w);
    }
    return best;
  }

  /**
   * Every whitespace-separated term must match (AND). `boost(doc)` adds to the score
   * (favourites, has-feed …); `filter` drops entries before scoring.
   */
  search(
    query: string,
    opts: { limit?: number; filter?: (d: T) => boolean; boost?: (d: T) => number } = {},
  ): SearchHit<T>[] {
    const terms = norm(query)
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9./_&!-]/g, ''))
      .filter(Boolean);
    const limit = opts.limit ?? 200;
    const out: SearchHit<T>[] = [];
    const masks = terms.map(maskOf);
    // Missing characters an entry may have and still match a term (typo budget; 0 below 3 chars).
    const budget = terms.map((t) => (t.length >= 7 ? 2 : t.length >= 3 ? 1 : 0));
    outer: for (const p of this.items) {
      for (let i = 0; i < terms.length; i++)
        if (popcount(masks[i]! & ~p.mask) > budget[i]!) continue outer;
      if (opts.filter && !opts.filter(p.doc)) continue;
      let score = 0;
      for (let i = 0; i < terms.length; i++) {
        const s = this.termScore(p, terms[i]!, masks[i]!);
        if (!s) {
          score = 0;
          break;
        }
        score += s;
      }
      if (!terms.length) score = 1;
      if (score > 0) out.push({ doc: p.doc, score: score + (opts.boost?.(p.doc) ?? 0) });
    }
    out.sort(
      (a, b) =>
        b.score - a.score ||
        a.doc.symbol.length - b.doc.symbol.length ||
        a.doc.symbol.localeCompare(b.doc.symbol),
    );
    return out.slice(0, limit);
  }
}
