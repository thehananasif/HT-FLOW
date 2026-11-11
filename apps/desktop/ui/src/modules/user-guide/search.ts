import { plainText } from './markdown';

export interface Article {
  id: string;
  title: string;
  section: string;
  /** Extra search words. */
  keywords?: string;
  /** Markdown-like body (see markdown.ts). */
  body: string;
  /** Ribbon module ids this article can open ("Open this window"). */
  opens?: string[];
}

export interface Hit {
  article: Article;
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

/** Every term must match somewhere; title matches weigh most, then keywords, then body. */
export function searchArticles(articles: readonly Article[], query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return articles.map((a) => ({ article: a, score: 0, snippet: '' }));
  const hits: Hit[] = [];
  for (const a of articles) {
    const title = a.title.toLowerCase();
    const kw = `${a.section} ${a.keywords ?? ''}`.toLowerCase();
    const body = plainText(a.body);
    const bodyL = body.toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const s =
        (title.includes(t) ? 10 : 0) + (kw.includes(t) ? 4 : 0) + (bodyL.includes(t) ? 1 : 0);
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (ok) hits.push({ article: a, score, snippet: snippetFor(body, terms[0]!) });
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
