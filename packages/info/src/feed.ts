import { stripHtml, parseFeedDate, hashString, truncate } from './text';
import {
  childElement,
  childElements,
  innerXml,
  localName,
  parseXml,
  textContent,
  type XmlElement,
} from './xml';

export interface FeedItem {
  /** De-duplication key: guid, else normalised link, else hash of title + date. */
  id: string;
  guid?: string;
  link: string;
  title: string;
  /** Plain-text summary (HTML stripped, ≤ 1200 chars). */
  summary: string;
  /** Epoch ms, or null when the feed gives no parsable date. */
  published: number | null;
  author?: string;
  categories: string[];
}

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'rdf';
  title: string;
  link: string;
  items: FeedItem[];
}

export class FeedParseError extends Error {}

const SUMMARY_MAX = 1200;

/** Normalises a link for de-duplication: drops fragments, tracking params and a trailing slash. */
export function normalizeLink(link: string): string {
  const s = link.trim();
  if (!s) return '';
  const hash = s.indexOf('#');
  const noHash = hash >= 0 ? s.slice(0, hash) : s;
  const q = noHash.indexOf('?');
  let base = q >= 0 ? noHash.slice(0, q) : noHash;
  const params =
    q >= 0
      ? noHash
          .slice(q + 1)
          .split('&')
          .filter((p) => p && !/^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid)=/i.test(p))
      : [];
  base = base.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
  return params.length ? `${base}?${params.join('&')}` : base;
}

export function itemKey(item: { guid?: string; link: string; title: string; published: number | null }) {
  if (item.guid?.trim()) return `g:${item.guid.trim()}`;
  const l = normalizeLink(item.link);
  if (l) return `l:${l}`;
  return `h:${hashString(`${item.title}|${item.published ?? ''}`)}`;
}

/** Resolves a possibly relative link against the feed / channel URL. */
function resolve(link: string, base: string | undefined): string {
  const l = link.trim();
  if (!l || !base) return l;
  try {
    return new URL(l, base).toString();
  } catch {
    return l;
  }
}

function text(el: XmlElement | undefined): string {
  return textContent(el).trim();
}

function atomText(el: XmlElement | undefined): string {
  if (!el) return '';
  const type = (el.attrs.type ?? 'text').toLowerCase();
  if (type === 'xhtml') {
    const div = childElement(el, 'div');
    return stripHtml(div ? innerXml(div) : innerXml(el));
  }
  if (type === 'html' || type === 'text/html') return stripHtml(textContent(el));
  return textContent(el).replace(/\s+/g, ' ').trim();
}

function mk(
  raw: Omit<FeedItem, 'id' | 'summary' | 'title'> & { title: string; summary: string },
): FeedItem {
  const title = raw.title.replace(/\s+/g, ' ').trim() || '(untitled)';
  const item: FeedItem = {
    ...raw,
    title,
    summary: truncate(raw.summary, SUMMARY_MAX),
    id: '',
  };
  if (!item.guid) delete item.guid;
  if (!item.author) delete item.author;
  item.id = itemKey(item);
  return item;
}

function parseRssItem(it: XmlElement, base: string | undefined): FeedItem {
  const guidEl = childElement(it, 'guid');
  const guid = text(guidEl);
  let link = text(childElement(it, 'link'));
  // <guid isPermaLink="true"> (the default) doubles as the link.
  if (!link && guid && guidEl?.attrs.isPermaLink !== 'false' && /^https?:\/\//i.test(guid))
    link = guid;
  const encoded = childElement(it, 'content:encoded');
  const desc = text(childElement(it, 'description')) || textContent(encoded);
  return mk({
    guid: guid || undefined,
    link: resolve(link, base),
    title: stripHtml(text(childElement(it, 'title'))),
    summary: stripHtml(desc),
    published: parseFeedDate(
      text(childElement(it, 'pubDate')) ||
        text(childElement(it, 'dc:date')) ||
        text(childElement(it, 'date')),
    ),
    author: text(childElement(it, 'dc:creator')) || text(childElement(it, 'author')) || undefined,
    categories: childElements(it, 'category')
      .map((c) => text(c))
      .filter(Boolean),
  });
}

function atomLink(el: XmlElement, base: string | undefined): string {
  const links = childElements(el, 'link');
  const alt =
    links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ??
    links.find((l) => l.attrs.rel !== 'self') ??
    links[0];
  return alt ? resolve(alt.attrs.href ?? '', el.attrs['xml:base'] ?? base) : '';
}

function parseAtomEntry(e: XmlElement, base: string | undefined): FeedItem {
  const author = childElement(e, 'author');
  return mk({
    guid: text(childElement(e, 'id')) || undefined,
    link: atomLink(e, base),
    title: atomText(childElement(e, 'title')),
    summary: atomText(childElement(e, 'summary')) || atomText(childElement(e, 'content')),
    published: parseFeedDate(
      text(childElement(e, 'published')) || text(childElement(e, 'updated')),
    ),
    author: author ? text(childElement(author, 'name')) || undefined : undefined,
    categories: childElements(e, 'category')
      .map((c) => c.attrs.term ?? c.attrs.label ?? '')
      .filter(Boolean),
  });
}

/**
 * Parses RSS 2.0 / 0.9x, RSS 1.0 (RDF) and Atom 1.0. `baseUrl` (the feed URL) resolves relative links.
 * Throws FeedParseError when the text is not a feed (e.g. an HTML error page).
 */
export function parseFeed(src: string, baseUrl?: string): ParsedFeed {
  const root = parseXml(src);
  if (!root) throw new FeedParseError('Not XML');
  const name = localName(root.name).toLowerCase();
  if (name === 'rss') {
    const ch = childElement(root, 'channel');
    if (!ch) throw new FeedParseError('RSS without <channel>');
    const link = resolve(text(childElement(ch, 'link')), baseUrl);
    const base = baseUrl ?? (link || undefined);
    return {
      kind: 'rss',
      title: stripHtml(text(childElement(ch, 'title'))),
      link,
      items: childElements(ch, 'item').map((it) => parseRssItem(it, base)),
    };
  }
  if (name === 'feed') {
    const base = root.attrs['xml:base'] ?? baseUrl;
    return {
      kind: 'atom',
      title: atomText(childElement(root, 'title')),
      link: atomLink(root, base),
      items: childElements(root, 'entry').map((e) => parseAtomEntry(e, base)),
    };
  }
  if (name === 'rdf') {
    const ch = childElement(root, 'channel');
    const link = resolve(text(ch && childElement(ch, 'link')), baseUrl);
    return {
      kind: 'rdf',
      title: stripHtml(text(ch && childElement(ch, 'title'))),
      link,
      items: childElements(root, 'item').map((it) => parseRssItem(it, baseUrl ?? link)),
    };
  }
  throw new FeedParseError(`Not a feed (root <${root.name}>)`);
}
