import { toast } from '@htflow/ui-kit';
import {
  dueFeeds,
  emptyReaderState,
  escapeXml,
  isHttpUrl,
  matchKeywords,
  mergeFeedItems,
  normalizeReaderState,
  parseFeed,
  type FeedSub,
  type ReaderState,
} from '@htflow/info';
import { fetchText, PersistedStore } from './shared';

export const FOLDERS = ['Crypto exchanges', 'Central banks', 'Regulators', 'Commodities'];
export const KEYWORDS_FOLDER = 'My keywords';

/**
 * Default feeds: well-known free public RSS URLs. UNVERIFIED — they could not be fetched from the
 * build sandbox, so each is marked `unverified` and stays editable / removable in the UI.
 */
const DEFAULT_FEEDS: Omit<FeedSub, 'enabled'>[] = [
  // unverified: Binance support announcement RSS
  { id: 'binance', url: 'https://www.binance.com/en/support/announcement/rss', title: 'Binance announcements', folder: 'Crypto exchanges', unverified: true },
  // unverified: Kraken blog (WordPress feed)
  { id: 'kraken', url: 'https://blog.kraken.com/feed', title: 'Kraken blog', folder: 'Crypto exchanges', unverified: true },
  // unverified: Federal Reserve press releases
  { id: 'fed', url: 'https://www.federalreserve.gov/feeds/press_all.xml', title: 'Federal Reserve press', folder: 'Central banks', unverified: true },
  // unverified: ECB press releases
  { id: 'ecb', url: 'https://www.ecb.europa.eu/rss/press.html', title: 'ECB press', folder: 'Central banks', unverified: true },
  // unverified: Bank of England news
  { id: 'boe', url: 'https://www.bankofengland.co.uk/rss/news', title: 'Bank of England news', folder: 'Central banks', unverified: true },
  // unverified: SEC press releases
  { id: 'sec', url: 'https://www.sec.gov/news/pressreleases.rss', title: 'SEC press releases', folder: 'Regulators', unverified: true },
  // unverified: CFTC general press releases
  { id: 'cftc', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', title: 'CFTC press', folder: 'Regulators', unverified: true },
  // unverified: EIA Today in Energy
  { id: 'eia', url: 'https://www.eia.gov/rss/todayinenergy.xml', title: 'EIA Today in Energy', folder: 'Commodities', unverified: true },
];

const DEFAULT_KEYWORDS = ['halt', 'listing', 'rate', 'delisting', 'FOMC'];

export function defaultReaderState(): ReaderState {
  return {
    ...emptyReaderState(),
    folders: [...FOLDERS],
    feeds: DEFAULT_FEEDS.map((f) => ({ ...f, enabled: true })),
    keywords: [...DEFAULT_KEYWORDS],
  };
}

/** Bundled OFFLINE SAMPLE headlines per default feed (shown only when nothing could be fetched). */
const SAMPLE: Record<string, [number, string, string][]> = {
  binance: [
    [0.3, 'Futures will launch a new USDⓈ-M NEWUSDT perpetual contract (sample)', 'Trading opens with up to 50x leverage. Keywords you watch (e.g. “halt”, “listing”, “rate”) are highlighted.'],
    [1.1, 'Scheduled wallet maintenance for one network (sample)', 'Deposits and withdrawals of BTC on one network pause during maintenance.'],
    [6.5, 'Delisting notice for low-liquidity spot pairs (sample)', 'Selected pairs will be delisted; open orders are cancelled.'],
  ],
  kraken: [[2.0, 'Adjustment of risk limit tiers for selected perpetuals (sample)', 'ETH and SOL perpetual risk limits change next week.']],
  fed: [[3.0, 'Policy statement release time confirmed (sample)', 'The FOMC statement will be released at 14:00 ET; rate decision follows the meeting.']],
  ecb: [[5.0, 'Monetary policy decisions — press conference schedule (sample)', 'The ECB announces the time of its rate decision press conference.']],
  boe: [[8.0, 'Bank Rate held — minutes published (sample)', 'Minutes of the Monetary Policy Committee meeting.']],
  sec: [[4.0, 'Weekly positions report published (sample)', 'Staff publishes the weekly report on positions.']],
  cftc: [[9.0, 'Commitments of Traders report released (sample)', 'Futures positions in crude oil, gold and S&P 500 futures.']],
  eia: [[7.0, 'Crude oil inventories build larger than expected (sample)', 'U.S. commercial crude inventories rose; WTI reacted.']],
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

export const reader = new PersistedStore<ReaderState>('rss', defaultReaderState, normalizeReaderState, () => {
  // First run / nothing cached yet: show the bundled offline sample, then try the network.
  const s = reader.get();
  for (const f of s.feeds) {
    if (!s.items.some((i) => i.feedId === f.id)) addSample(f.id);
  }
  void refreshAll(true);
});

function addSample(feedId: string) {
  const xml = sampleFeedXml(feedId, Date.now());
  if (!xml) return;
  const { state } = mergeFeedItems(reader.get(), feedId, parseFeed(xml).items, Date.now(), { sample: true });
  reader.set(state);
}

const inflight = new Set<string>();

/** Fetches one feed and merges it into the offline cache. Returns new items. */
export async function refreshFeed(feedId: string, quiet = false): Promise<number> {
  const f = reader.get().feeds.find((x) => x.id === feedId);
  if (!f || inflight.has(feedId)) return 0;
  inflight.add(feedId);
  const patch = (p: Partial<FeedSub>) =>
    reader.update((s) => ({ ...s, feeds: s.feeds.map((x) => (x.id === feedId ? { ...x, ...p } : x)) }));
  try {
    const text = await fetchText(f.url);
    const parsed = parseFeed(text, f.url);
    const { state, added } = mergeFeedItems(reader.get(), feedId, parsed.items, Date.now());
    reader.set(state);
    patch({ lastFetched: Date.now(), lastError: undefined });
    const hits = added.filter((a) => matchKeywords([a.title, a.summary], state.keywords).length);
    if (hits.length && !quiet)
      toast('warning', `Keyword: ${matchKeywords([hits[0]!.title, hits[0]!.summary], state.keywords).join(', ')}`, hits[0]!.title);
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
  await Promise.all(list.map((f) => refreshFeed(f.id, onlyDue)));
}

export function addFeed(url: string, title: string, folder: string): string | null {
  const u = url.trim();
  if (!isHttpUrl(u)) return 'Enter an http:// or https:// feed URL';
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
  reader.update((s) => ({ ...s, feeds: s.feeds.filter((f) => f.id !== id), items: s.items.filter((i) => i.feedId !== id) }));
}

// Auto-refresh (interval from settings), only once the profile's state is loaded.
setInterval(() => {
  if (reader.loaded) void refreshAll(true);
}, 60_000);
