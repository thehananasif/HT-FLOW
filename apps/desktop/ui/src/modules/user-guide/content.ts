import { parseFrontMatter, parseMarkdown, sectionsOf } from './markdown';
import { getLocale } from '@htflow/i18n';
import type { Article } from './search';

/**
 * Guide sources: docs/user-guide/*.md (English) and docs/user-guide/<lang>/*.md for translations.
 * Bundled at build time (Vite `?raw`), so the guide works offline. Images live in
 * docs/user-guide/images/ and are bundled the same way.
 */
const RAW = import.meta.glob('../../../../../../docs/user-guide/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const IMAGES = import.meta.glob('../../../../../../docs/user-guide/images/*.{webp,png,jpg}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const imageByName = new Map<string, string>(
  Object.entries(IMAGES).map(([p, url]) => [p.split('/').pop()!, url]),
);

/** Bundled URL of `images/<name>` as written in the markdown, or undefined when missing. */
export function guideImage(src: string): string | undefined {
  return imageByName.get(src.split('/').pop() ?? '');
}

export function buildArticles(raw: Record<string, string>, lang = 'en'): Article[] {
  const out: Article[] = [];
  for (const [path, src] of Object.entries(raw)) {
    const m = /user-guide\/(?:([a-z]{2}(?:-[A-Za-z]+)?)\/)?([^/]+)\.md$/.exec(path);
    if (!m || m[2] === 'README') continue;
    if ((m[1] ?? 'en') !== lang) continue;
    const file = m[2]!;
    const { meta, body } = parseFrontMatter(src);
    const blocks = parseMarkdown(body);
    out.push({
      id: meta.id || file.replace(/^\d+-/, ''),
      file,
      order: Number(/^(\d+)-/.exec(file)?.[1] ?? 999),
      title: meta.title || file,
      section: meta.section || 'Guide',
      keywords: meta.keywords,
      opens: meta.opens
        ? meta.opens
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      isNew: meta.new === 'true',
      body,
      blocks,
      parts: sectionsOf(blocks),
    });
  }
  return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Language of the guide: the UI language (translations go in docs/user-guide/<lang>/). */
export function guideLanguage(): string {
  return getLocale();
}

/**
 * Articles in `lang`; every article without a translation falls back to its English version, so a
 * partly translated folder (or none at all) never leaves the guide empty.
 */
export function articlesFor(lang: string, raw: Record<string, string> = RAW): Article[] {
  const english = buildArticles(raw, 'en');
  if (lang === 'en') return english;
  const translated = new Map(buildArticles(raw, lang).map((a) => [a.file, a]));
  return english.map((a) => translated.get(a.file) ?? a);
}

export const ARTICLES: Article[] = buildArticles(RAW, 'en');

const cache = new Map<string, Article[]>();
/** The articles for the current UI language (English fallback per article), cached per language. */
export function currentArticles(): Article[] {
  const lang = guideLanguage();
  let a = cache.get(lang);
  if (!a) cache.set(lang, (a = articlesFor(lang)));
  return a;
}
