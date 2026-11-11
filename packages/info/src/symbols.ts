/** Symbol tagging: maps words and tickers in headlines to instrument roots (BTC, CL, ES, …). */

export type TagClass = 'crypto' | 'future' | 'macro';

export interface SymbolRule {
  /** Instrument root the rule tags, e.g. 'BTC', 'CL', 'ES'. */
  root: string;
  cls: TagClass;
  /** Case-insensitive whole-word terms. Upper-case-only terms (≤ 5 chars) must match case. */
  terms: string[];
}

/** Editable defaults (user rules are appended in the UI). */
export const DEFAULT_SYMBOL_RULES: SymbolRule[] = [
  { root: 'BTC', cls: 'crypto', terms: ['bitcoin', 'BTC', 'XBT'] },
  { root: 'ETH', cls: 'crypto', terms: ['ethereum', 'ether', 'ETH'] },
  { root: 'SOL', cls: 'crypto', terms: ['solana', 'SOL'] },
  { root: 'BNB', cls: 'crypto', terms: ['BNB'] },
  { root: 'XRP', cls: 'crypto', terms: ['XRP', 'ripple'] },
  { root: 'DOGE', cls: 'crypto', terms: ['dogecoin', 'DOGE'] },
  { root: 'CL', cls: 'future', terms: ['crude', 'crude oil', 'WTI', 'OPEC', 'oil inventories'] },
  { root: 'GC', cls: 'future', terms: ['gold', 'bullion'] },
  { root: 'SI', cls: 'future', terms: ['silver'] },
  { root: 'NG', cls: 'future', terms: ['natural gas'] },
  { root: 'ES', cls: 'future', terms: ['S&P 500', 'S&P', 'SPX', 'equity index futures'] },
  { root: 'NQ', cls: 'future', terms: ['Nasdaq', 'NDX'] },
  { root: 'ZN', cls: 'future', terms: ['Treasury', 'Treasuries', '10-year'] },
  {
    root: 'USD',
    cls: 'macro',
    terms: ['FOMC', 'Federal Reserve', 'Fed', 'CPI', 'payrolls', 'NFP', 'jobless claims', 'PCE'],
  },
  { root: 'EUR', cls: 'macro', terms: ['ECB', 'euro area', 'eurozone'] },
  { root: 'GBP', cls: 'macro', terms: ['Bank of England', 'BoE'] },
  { root: 'JPY', cls: 'macro', terms: ['Bank of Japan', 'BoJ'] },
];

const QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD', 'PERP'];
const MONTH_CODES = 'FGHJKMNQUVXZ';

/**
 * Root of a venue symbol: futures drop the month/year code (CLZ6 → CL, 6EZ26 → 6E),
 * crypto drops the quote currency and perpetual suffix (BTCUSDT → BTC, NEWUSDT.P → NEW).
 */
export function instrumentRoot(symbol: string): string {
  let s = symbol.toUpperCase().replace(/[.-]P(ERP)?$/, '');
  const fut = new RegExp(`^([A-Z0-9]{1,4}?)[${MONTH_CODES}]\\d{1,2}$`).exec(s);
  if (fut) return fut[1]!;
  for (const q of QUOTES) {
    if (s.length > q.length + 1 && s.endsWith(q)) {
      s = s.slice(0, -q.length);
      break;
    }
  }
  return s;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRe(term: string): RegExp {
  const caseSensitive = term.length <= 5 && term === term.toUpperCase() && /[A-Z]/.test(term);
  const pre = /^\w/.test(term) ? '(?<![\\w$])' : '';
  const post = /\w$/.test(term) ? '(?![\\w])' : '';
  return new RegExp(`${pre}${escapeRe(term)}${post}`, caseSensitive ? 'u' : 'iu');
}

const reCache = new Map<string, RegExp>();
function cachedRe(term: string): RegExp {
  let r = reCache.get(term);
  if (!r) {
    r = termRe(term);
    reCache.set(term, r);
  }
  return r;
}

/** Explicit tickers in text, e.g. "NEWUSDT", "BTCUSDT.P", "$ETH". */
const TICKER_RE =
  /(?<![\w])([A-Z0-9]{2,12}(?:USDT|USDC|BUSD|FDUSD)(?:\.P)?)(?![\w])|\$([A-Z]{2,6})\b/g;

export interface SymbolTag {
  root: string;
  cls: TagClass;
  /** Exact ticker when the text names one (NEWUSDT.P). */
  ticker?: string;
}

/** Tags a headline / summary with instrument roots (ordered by first appearance, unique). */
export function tagSymbols(
  text: string,
  rules: readonly SymbolRule[] = DEFAULT_SYMBOL_RULES,
): SymbolTag[] {
  const hits: { at: number; tag: SymbolTag }[] = [];
  for (const m of text.matchAll(TICKER_RE)) {
    const ticker = m[1] ?? m[2]!;
    hits.push({ at: m.index ?? 0, tag: { root: instrumentRoot(ticker), cls: 'crypto', ticker } });
  }
  for (const r of rules) {
    let best = -1;
    for (const term of r.terms) {
      if (!term.trim()) continue;
      const m = cachedRe(term.trim()).exec(text);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    if (best >= 0) hits.push({ at: best, tag: { root: r.root, cls: r.cls } });
  }
  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: SymbolTag[] = [];
  for (const h of hits) {
    if (seen.has(h.tag.root)) {
      // Prefer the explicit ticker when both a word and a ticker named the same root.
      const prev = out.find((t) => t.root === h.tag.root);
      if (prev && !prev.ticker && h.tag.ticker) prev.ticker = h.tag.ticker;
      continue;
    }
    seen.add(h.tag.root);
    out.push({ ...h.tag });
  }
  return out;
}

/** Display label for a tag: the ticker when known, otherwise the root. */
export const tagLabel = (t: SymbolTag) => t.ticker ?? t.root;

/**
 * Which instrument roots a calendar currency moves (vertical event lines on "affected" charts).
 * USD data moves US index/energy/metal futures and USD-quoted crypto.
 */
export const DEFAULT_CURRENCY_ROOTS: Record<string, string[]> = {
  USD: [
    'ES',
    'NQ',
    'YM',
    'RTY',
    'CL',
    'GC',
    'SI',
    'NG',
    'ZN',
    'ZB',
    'BTC',
    'ETH',
    'SOL',
    '*crypto',
  ],
  EUR: ['6E', 'FDAX', 'FESX', 'FGBL'],
  GBP: ['6B', 'FTSE'],
  JPY: ['6J', 'NKD'],
  AUD: ['6A'],
  CAD: ['6C', 'CL'],
  CHF: ['6S'],
  NZD: ['6N'],
  CNY: ['CL', 'HG'],
};

/** True when an event in `currency` affects an instrument (root + asset class). */
export function currencyAffects(
  currency: string,
  root: string,
  assetClass: string,
  map: Record<string, string[]> = DEFAULT_CURRENCY_ROOTS,
): boolean {
  const roots = map[currency.toUpperCase()];
  if (!roots) return false;
  if (roots.includes(root.toUpperCase())) return true;
  return assetClass === 'crypto' && roots.includes('*crypto');
}
