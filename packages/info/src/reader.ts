import type { FeedItem } from './feed';
import { safeLink } from './feed';
import { normalizeKeywords } from './keywords';

/** One subscribed feed. */
export interface FeedSub {
  id: string;
  url: string;
  title: string;
  folder: string;
  enabled: boolean;
  /** Default feeds whose URL could not be verified when HT Flow was built. */
  unverified?: boolean;
  lastFetched?: number;
  lastError?: string;
}

/** A cached item (offline cache): the parsed item plus local state. */
export interface CachedItem extends FeedItem {
  feedId: string;
  fetchedAt: number;
  read: boolean;
  /** Bundled offline sample, never real news. */
  sample?: boolean;
}

export interface ReaderState {
  version: 1;
  folders: string[];
  feeds: FeedSub[];
  items: CachedItem[];
  keywords: string[];
  /** Auto-refresh interval in minutes (0 = manual). */
  refreshMin: number;
  /** Items kept per feed in the offline cache. */
  maxPerFeed: number;
}

export const REFRESH_CHOICES = [0, 5, 15, 30, 60, 240] as const;
export const DEFAULT_REFRESH_MIN = 15;
export const DEFAULT_MAX_PER_FEED = 100;

export function emptyReaderState(): ReaderState {
  return {
    version: 1,
    folders: [],
    feeds: [],
    items: [],
    keywords: [],
    refreshMin: DEFAULT_REFRESH_MIN,
    maxPerFeed: DEFAULT_MAX_PER_FEED,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validates persisted / imported state; anything malformed is dropped, settings get defaults. */
export function normalizeReaderState(raw: unknown): ReaderState {
  const s = emptyReaderState();
  if (!isObj(raw)) return s;
  if (Array.isArray(raw.feeds)) {
    const ids = new Set<string>();
    for (const f of raw.feeds) {
      if (!isObj(f)) continue;
      const id = str(f.id);
      const url = str(f.url).trim();
      if (!id || ids.has(id) || !isHttpUrl(url)) continue;
      ids.add(id);
      const sub: FeedSub = {
        id,
        url,
        title: str(f.title, url) || url,
        folder: str(f.folder),
        enabled: f.enabled !== false,
      };
      if (f.unverified === true) sub.unverified = true;
      const lf = num(f.lastFetched);
      if (lf !== undefined) sub.lastFetched = lf;
      if (typeof f.lastError === 'string') sub.lastError = f.lastError;
      s.feeds.push(sub);
    }
  }
  const feedIds = new Set(s.feeds.map((f) => f.id));
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      if (!isObj(it) || !feedIds.has(str(it.feedId)) || !str(it.id)) continue;
      const item: CachedItem = {
        id: str(it.id),
        link: safeLink(str(it.link)),
        title: str(it.title, '(untitled)'),
        summary: str(it.summary),
        published: num(it.published) ?? null,
        categories: Array.isArray(it.categories)
          ? it.categories.filter((c) => typeof c === 'string')
          : [],
        feedId: str(it.feedId),
        fetchedAt: num(it.fetchedAt) ?? 0,
        read: it.read === true,
      };
      if (typeof it.guid === 'string') item.guid = it.guid;
      if (typeof it.author === 'string') item.author = it.author;
      if (it.sample === true) item.sample = true;
      s.items.push(item);
    }
  }
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter((f) => typeof f === 'string')
    : [];
  s.folders = [...new Set([...folders, ...s.feeds.map((f) => f.folder).filter(Boolean)])];
  s.keywords = normalizeKeywords(
    Array.isArray(raw.keywords) ? raw.keywords.filter((k) => typeof k === 'string') : [],
  );
  const r = num(raw.refreshMin);
  s.refreshMin = r !== undefined && r >= 0 && r <= 1440 ? Math.round(r) : DEFAULT_REFRESH_MIN;
  const m = num(raw.maxPerFeed);
  s.maxPerFeed = m !== undefined && m >= 10 && m <= 1000 ? Math.round(m) : DEFAULT_MAX_PER_FEED;
  return s;
}

const itemTime = (i: Pick<CachedItem, 'published' | 'fetchedAt'>) => i.published ?? i.fetchedAt;

/**
 * Merges freshly fetched items of one feed into the cache:
 * - de-duplicates by item id (guid → link → hash) across all feeds (first feed wins);
 * - keeps read state and fetchedAt of known items, updates their text;
 * - replaces the feed's bundled sample items once real items arrive;
 * - keeps the newest `maxPerFeed` items of the feed.
 */
export function mergeFeedItems(
  state: ReaderState,
  feedId: string,
  incoming: readonly FeedItem[],
  now: number,
  opts: { sample?: boolean } = {},
): { state: ReaderState; added: CachedItem[] } {
  const real = !opts.sample;
  const kept = state.items.filter((i) => !(real && i.sample && i.feedId === feedId));
  const byId = new Map(kept.map((i) => [i.id, i]));
  const added: CachedItem[] = [];
  const updated = new Map<string, CachedItem>();
  for (const it of incoming) {
    const prev = byId.get(it.id) ?? updated.get(it.id);
    if (prev) {
      if (prev.feedId === feedId && !updated.has(it.id))
        updated.set(it.id, { ...prev, ...it, feedId, fetchedAt: prev.fetchedAt, read: prev.read });
      continue;
    }
    const c: CachedItem = { ...it, feedId, fetchedAt: now, read: false };
    if (opts.sample) c.sample = true;
    added.push(c);
    byId.set(it.id, c);
  }
  let items = kept.map((i) => updated.get(i.id) ?? i).concat(added);
  // Cap per feed: newest first.
  const mine = items.filter((i) => i.feedId === feedId).sort((a, b) => itemTime(b) - itemTime(a));
  if (mine.length > state.maxPerFeed) {
    const drop = new Set(mine.slice(state.maxPerFeed).map((i) => i.id));
    items = items.filter((i) => i.feedId !== feedId || !drop.has(i.id));
  }
  const addedIds = new Set(items.map((i) => i.id));
  return {
    state: { ...state, items },
    added: added.filter((a) => addedIds.has(a.id)),
  };
}

export function setRead(state: ReaderState, ids: readonly string[], read: boolean): ReaderState {
  const set = new Set(ids);
  return {
    ...state,
    items: state.items.map((i) => (set.has(i.id) && i.read !== read ? { ...i, read } : i)),
  };
}

/** Unread counts per feed id and per folder name. */
export function unreadCounts(state: Pick<ReaderState, 'feeds' | 'items'>): {
  feeds: Map<string, number>;
  folders: Map<string, number>;
  total: number;
} {
  const feeds = new Map<string, number>();
  const folderOf = new Map(state.feeds.map((f) => [f.id, f.folder]));
  const folders = new Map<string, number>();
  let total = 0;
  for (const i of state.items) {
    if (i.read) continue;
    total++;
    feeds.set(i.feedId, (feeds.get(i.feedId) ?? 0) + 1);
    const fo = folderOf.get(i.feedId);
    if (fo !== undefined) folders.set(fo, (folders.get(fo) ?? 0) + 1);
  }
  return { feeds, folders, total };
}

/** Newest first. */
export function sortItems<T extends Pick<CachedItem, 'published' | 'fetchedAt'>>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => itemTime(b) - itemTime(a));
}

export { itemTime };

/** Feeds due for refresh (enabled and older than the interval). */
export function dueFeeds(state: ReaderState, now: number): FeedSub[] {
  if (state.refreshMin <= 0) return [];
  const ms = state.refreshMin * 60_000;
  return state.feeds.filter((f) => f.enabled && (!f.lastFetched || now - f.lastFetched >= ms));
}
