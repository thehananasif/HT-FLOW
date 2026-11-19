import { toast } from '@htflow/ui-kit';
import {
  dueFeeds,
  emptyReaderState,
  escapeXml,
  isHttpUrl,
  matchKeywords,
  mergeFeedItems,
  nativeItemsToFeedItems,
  type FeedItem,
  normalizeReaderState,
  parseFeed,
  type FeedSub,
  type ReaderState,
} from '@htflow/info';
import { fetchText, PersistedStore } from './shared';
import {
  nativeAvailable,
  nativeFeedAllowAdd,
  nativeFeedAllowRemove,
  nativeFeedFetch,
} from './native';

import { tt } from '@htflow/i18n';
export const FOLDERS = [
  'Crypto news',
  'Crypto exchanges',
  'Central banks',
  'Regulators',
  'Commodities',
];
export const KEYWORDS_FOLDER = 'My keywords';

/** Bump when DEFAULT_FEEDS changes: missing defaults are merged into existing profiles once. */
export const DEFAULTS_VERSION = 2;

/**
 * Default feeds: free public RSS URLs without any key, each checked live to answer with a valid
 * RSS feed (see docs/DATA-SOURCES.md). Hosts are on the native allow-list (feed_cmds.rs).
 */
export const DEFAULT_FEEDS: Omit<FeedSub, 'enabled'>[] = [
  {
    id: 'cointelegraph',
    url: 'https://cointelegraph.com/rss',
    title: 'Cointelegraph',
    folder: 'Crypto news',
  },
  { id: 'decrypt', url: 'https://decrypt.co/feed', title: 'Decrypt', folder: 'Crypto news' },
  {
    id: 'cryptoslate',
    url: 'https://cryptoslate.com/feed/',
    title: 'CryptoSlate',
    folder: 'Crypto news',
  },
  {
    id: 'theblock',
    url: 'https://www.theblock.co/rss.xml',
    title: 'The Block',
    folder: 'Crypto news',
  },
  {
    id: 'coindesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss',
    title: 'CoinDesk',
    folder: 'Crypto news',
  },
  {
    id: 'kraken',
    url: 'https://blog.kraken.com/feed',
    title: 'Kraken blog',
    folder: 'Crypto exchanges',
  },
  {
    id: 'fed',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    title: 'Federal Reserve press',
    folder: 'Central banks',
  },
  {
    id: 'fed-monetary',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    title: 'Federal Reserve monetary policy',
    folder: 'Central banks',
  },
  {
    id: 'ecb',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    title: 'ECB press',
    folder: 'Central banks',
  },
  {
    id: 'boe',
    url: 'https://www.bankofengland.co.uk/rss/news',
    title: 'Bank of England news',
    folder: 'Central banks',
  },
  {
    id: 'sec',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    title: 'SEC press releases',
    folder: 'Regulators',
  },
  {
    id: 'cftc',
    url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml',
    title: 'CFTC press',
    folder: 'Regulators',
  },
  {
    id: 'eia',
    url: 'https://www.eia.gov/rss/todayinenergy.xml',
    title: 'EIA Today in Energy',
    folder: 'Commodities',
  },
];

const DEFAULT_KEYWORDS = ['halt', 'listing', 'rate', 'delisting', 'FOMC'];

export function defaultReaderState(): ReaderState {
  return {
    ...emptyReaderState(),
    folders: [...FOLDERS],
    feeds: DEFAULT_FEEDS.map((f) => ({ ...f, enabled: true })),
    keywords: [...DEFAULT_KEYWORDS],
    defaultsVersion: DEFAULTS_VERSION,
  };
}

/** Bundled OFFLINE SAMPLE headlines (last resort: shown only for a feed that has neither real items nor a cache). */
const SAMPLE: Record<string, [number, string, string][]> = {
  cointelegraph: [
    [
      0.3,
      'Futures will launch a new USDⓈ-M NEWUSDT perpetual contract (sample)',
      'Trading opens with up to 50x leverage. Keywords you watch (e.g. “halt”, “listing”, “rate”) are highlighted.',
    ],
    [
      1.1,
      'Scheduled wallet maintenance for one network (sample)',
      'Deposits and withdrawals of BTC on one network pause during maintenance.',
    ],
    [
      6.5,
      'Delisting notice for low-liquidity spot pairs (sample)',
      'Selected pairs will be delisted; open orders are cancelled.',
    ],
  ],
  kraken: [
    [
      2.0,
      'Adjustment of risk limit tiers for selected perpetuals (sample)',
      'ETH and SOL perpetual risk limits change next week.',
    ],
  ],
  fed: [
    [
      3.0,
      'Policy statement release time confirmed (sample)',
      'The FOMC statement will be released at 14:00 ET; rate decision follows the meeting.',
    ],
  ],
  ecb: [
    [
      5.0,
      'Monetary policy decisions — press conference schedule (sample)',
      'The ECB announces the time of its rate decision press conference.',
    ],
  ],
  boe: [
    [
      8.0,
      'Bank Rate held — minutes published (sample)',
      'Minutes of the Monetary Policy Committee meeting.',
    ],
  ],
  sec: [
    [
      4.0,
      'Weekly positions report published (sample)',
      'Staff publishes the weekly report on positions.',
    ],
  ],
  cftc: [
    [
      9.0,
      'Commitments of Traders report released (sample)',
      'Futures positions in crude oil, gold and S&P 500 futures.',
    ],
  ],
  eia: [
    [
      7.0,
      'Crude oil inventories build larger than expected (sample)',
      'U.S. commercial crude inventories rose; WTI reacted.',
    ],
  ],
};

export function sampleFeedXml(feedId: string, now: number): string | null {
  const rows = SAMPLE[feedId];
  if (!rows) return null;
  const items = rows
    .map(
      ([h, title, desc], i) =>
        `<item><title>${escapeXml(title)}</title><guid isPermaLink="false">sample-${feedId}-${i}</guid><pubDate>${new Date(now - h * 3_600_000).toUTCString()}</pubDate><description>${escapeXml(desc + ' Offline sample bundled with HT Flow — not real news.')}</description></item>`,
    )
    .join('');
  return `<rss version="2.0"><channel><title>Offline sample</title>${items}</channel></rss>`;
}

/** Merges default feeds this profile has not seen yet (once per DEFAULTS_VERSION). */
export function migrateDefaults(s: ReaderState): ReaderState {
  if ((s.defaultsVersion ?? 0) >= DEFAULTS_VERSION) return s;
  const have = new Set(s.feeds.map((f) => f.id));
  const urls = new Set(s.feeds.map((f) => f.url));
  const add = DEFAULT_FEEDS.filter((f) => !have.has(f.id) && !urls.has(f.url)).map((f) => ({
    ...f,
    enabled: true,
  }));
  // The old default Binance announcement URL blocks automated clients (HTTP 405): drop it.
  const feeds = [...s.feeds.filter((f) => !(f.id === 'binance' && f.unverified)), ...add];
  return {
    ...s,
    feeds,
    folders: [...new Set([...s.folders, ...feeds.map((f) => f.folder).filter(Boolean)])],
    defaultsVersion: DEFAULTS_VERSION,
  };
}

export const reader = new PersistedStore<ReaderState>(
  'rss',
  defaultReaderState,
  normalizeReaderState,
  () => {
    reader.set(migrateDefaults(reader.get()));
    // Real data first; bundled sample headlines only for feeds that stay empty (offline, no cache).
    void refreshAll(true).then(() => {
      const s = reader.get();
      for (const f of s.feeds)
        if (f.enabled && f.lastError && !s.items.some((i) => i.feedId === f.id)) addSample(f.id);
    });
  },
);

function addSample(feedId: string) {
  const xml = sampleFeedXml(feedId, Date.now());
  if (!xml) return;
  const { state } = mergeFeedItems(reader.get(), feedId, parseFeed(xml).items, Date.now(), {
    sample: true,
  });
  reader.set(state);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const inflight = new Set<string>();

/** Fetches one feed and merges it into the offline cache. Returns new items. */
export async function refreshFeed(feedId: string, quiet = false, force = false): Promise<number> {
  const f = reader.get().feeds.find((x) => x.id === feedId);
  if (!f || inflight.has(feedId)) return 0;
  inflight.add(feedId);
  const patch = (p: Partial<FeedSub>) =>
    reader.update((s) => ({
      ...s,
      feeds: s.feeds.map((x) => (x.id === feedId ? { ...x, ...p } : x)),
    }));
  try {
    let incoming: FeedItem[];
    let stale: string | undefined;
    if (nativeAvailable()) {
      await nativeFeedAllowAdd(f.url);
      const res = await nativeFeedFetch(f.url, force);
      incoming = nativeItemsToFeedItems(res.items);
      if (res.stale) stale = `${res.error ?? 'offline'} — showing cached items`;
    } else {
      incoming = parseFeed(await fetchText(f.url), f.url).items;
    }
    const { state, added } = mergeFeedItems(reader.get(), feedId, incoming, Date.now());
    reader.set(state);
    patch({ lastFetched: Date.now(), lastError: stale });
    const hits = added.filter((a) => matchKeywords([a.title, a.summary], state.keywords).length);
    if (hits.length && !quiet)
      toast(
        'warning',
        tt`Keyword: ${matchKeywords([hits[0]!.title, hits[0]!.summary], state.keywords).join(', ')}`,
        hits[0]!.title,
      );
    return added.length;
  } catch (e) {
    patch({ lastFetched: Date.now(), lastError: e instanceof Error ? e.message : String(e) });
    return 0;
  } finally {
    inflight.delete(feedId);
  }
}

export async function refreshAll(onlyDue = false): Promise<void> {
  const s = reader.get();
  const list = onlyDue ? dueFeeds(s, Date.now()) : s.feeds.filter((f) => f.enabled);
  await Promise.all(list.map((f) => refreshFeed(f.id, onlyDue, !onlyDue)));
}

export function addFeed(url: string, title: string, folder: string): string | null {
  const u = url.trim();
  if (nativeAvailable() ? !/^https:\/\/[^\s/]+/i.test(u) : !isHttpUrl(u))
    return nativeAvailable()
      ? 'Enter an https:// feed URL'
      : 'Enter an http:// or https:// feed URL';
  const s = reader.get();
  if (s.feeds.some((f) => f.url === u)) return 'This feed is already subscribed';
  const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  reader.set({
    ...s,
    folders: s.folders.includes(folder) || !folder ? s.folders : [...s.folders, folder],
    feeds: [...s.feeds, { id, url: u, title: title.trim() || u, folder, enabled: true }],
  });
  void refreshFeed(id);
  return null;
}

export function removeFeed(id: string): void {
  const gone = reader.get().feeds.find((f) => f.id === id);
  const host = gone ? hostOf(gone.url) : null;
  if (
    host &&
    nativeAvailable() &&
    !reader.get().feeds.some((f) => f.id !== id && hostOf(f.url) === host)
  )
    void nativeFeedAllowRemove(host).catch(() => {});
  reader.update((s) => ({
    ...s,
    feeds: s.feeds.filter((f) => f.id !== id),
    items: s.items.filter((i) => i.feedId !== id),
  }));
}

// Auto-refresh (interval from settings), only once the profile's state is loaded.
setInterval(() => {
  if (reader.loaded) void refreshAll(true);
}, 60_000);
