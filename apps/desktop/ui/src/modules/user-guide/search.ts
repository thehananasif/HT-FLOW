import { plainText, type Block, type Section } from './markdown';

export interface Article {
  id: string;
  /** File name without .md (e.g. `04-charts`), used by links between articles. */
  file?: string;
  order?: number;
  title: string;
  section: string;
  /** Extra search words. */
  keywords?: string;
  /** Marks articles for features arriving in this release. */
  isNew?: boolean;
  /** Markdown source (see markdown.ts). */
  body: string;
  /** Parsed blocks; derived from `body` when omitted. */
  blocks?: Block[];
  parts?: Section[];
  /** Ribbon module ids this article can open ("Open this window"). */
  opens?: string[];
}

export interface Hit {
  article: Article;
  /** Heading anchor of the best matching section ('' = whole article). */
  anchor: string;
  /** Section heading of the match. */
  heading: string;
  score: number;
  /** A short excerpt around the first body match. */
  snippet: string;
}

function snippetFor(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return text.slice(0, 120);
  const start = Math.max(0, i - 40);
  return (
    (start > 0 ? '…' : '') + text.slice(start, start + 140) + (start + 140 < text.length ? '…' : '')
  );
}

/**
 * Section-level search: every term must match within one section (or the article title /
 * keywords); heading matches weigh most. One hit per article (its best section), sorted by score.
 */
export function searchArticles(articles: readonly Article[], query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length)
    return articles.map((a) => ({ article: a, anchor: '', heading: '', score: 0, snippet: '' }));
  const hits: Hit[] = [];
  for (const a of articles) {
    const title = a.title.toLowerCase();
    const kw = `${a.section} ${a.keywords ?? ''}`.toLowerCase();
    const parts = a.parts ?? [{ id: '', title: '', text: plainText(a.body) }];
    let best: Hit | null = null;
    for (const p of parts) {
      const ph = p.title.toLowerCase();
      const body = p.text.toLowerCase();
      let score = 0;
      let ok = true;
      for (const t of terms) {
        const s =
          (title.includes(t) ? 10 : 0) +
          (ph.includes(t) ? 6 : 0) +
          (kw.includes(t) ? 4 : 0) +
          (body.includes(t) ? 1 : 0);
        if (!s) {
          ok = false;
          break;
        }
        score += s;
      }
      if (ok && (!best || score > best.score))
        best = {
          article: a,
          anchor: p.id,
          heading: p.title,
          score,
          snippet: snippetFor(p.text, terms[0]!),
        };
    }
    if (best) hits.push(best);
  }
  return hits.sort((x, y) => y.score - x.score || x.article.title.localeCompare(y.article.title));
}

export function sections(articles: readonly Article[]): { name: string; items: Article[] }[] {
  const out: { name: string; items: Article[] }[] = [];
  for (const a of articles) {
    let s = out.find((x) => x.name === a.section);
    if (!s) out.push((s = { name: a.section, items: [] }));
    s.items.push(a);
  }
  return out;
}

export type { Block };
