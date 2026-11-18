import { MarketHub, MockFeed, type FeedSource } from '@htflow/market-data';
import { PaperEngine } from '@htflow/trading';
import { isTauri } from '../backend';
import { instrumentById, LIVE_INSTRUMENTS } from './instruments';
import { TauriLiveFeed } from './liveFeed';
import { providerFor } from '../feeds/registry';

function createFeed(instrumentId: string): FeedSource {
  const provider = providerFor(instrumentId);
  if (provider) return provider.create(instrumentId);
  if (instrumentId.startsWith('binance-futures:')) {
    const inst = LIVE_INSTRUMENTS.find((i) => i.id === instrumentId);
    if (!inst) throw new Error(`Unknown instrument ${instrumentId}`);
    if (isTauri) return new TauriLiveFeed({ ...inst }, 'binance-futures');
    // Browser preview has no native connectors; fall back to a simulator on the same symbol.
    return new MockFeed('BTCUSDT');
  }
  return new MockFeed(instrumentId.replace(/^mock:/, ''));
}

/** One feed + store per instrument shared by every window (Live Pipeline stage 7 cache key). */
export const hub = new MarketHub(createFeed);

export const PAPER_ACCOUNT = 'paper-3505';

export const paper = new PaperEngine({
  book: (id) => hub.peek(id)?.book,
  economics: (id) => {
    const live = hub.peek(id)?.instrument;
    const stat = instrumentById(id);
    // A feed that has not reported a tick size yet falls back to the catalog instrument.
    const tickSize = live && live.tickSize > 0 ? live.tickSize : (stat?.tickSize ?? 1);
    return { tickSize, tickValue: live?.tickValue ?? stat?.tickValue ?? 0 };
  },
  // Before the first live trade (e.g. a position restored at start-up): last history trade / mid.
  mark: (id) => {
    const s = hub.peek(id);
    if (!s) return undefined;
    const px = s.lastTrade?.px ?? s.book.mid;
    return Number.isFinite(px) ? px : undefined;
  },
});

paper.createAccount({
  id: PAPER_ACCOUNT,
  name: 'Paper · ••••3505',
  startingBalance: 50_000,
  commissionPerUnit: 0.0,
});

// Every live/mock trade reaches the paper engine (Live Pipeline stage 11).
// Keyed by the id the store was requested under: a fallback feed (e.g. the browser preview's
// simulator for a live venue symbol) reports its own instrument id, and orders / positions use
// the requested one — keying by the feed's id left their P&L at zero and limits unfilled.
hub.onStore((store, key) => {
  store.onTrades((trades) => {
    for (const t of trades) paper.onTrade(key, t);
  });
});

/**
 * Keeps the feed of every instrument with an open position or a working order alive, so its
 * marks keep reaching the engine (unrealized P&L, stops, limits) after its last chart / DOM
 * window closes or a restart restores the position. Replay instruments are driven elsewhere.
 */
const kept = new Set<string>();
export function keepTradedFeeds(): void {
  const want = new Set<string>();
  for (const p of paper.allPositions()) want.add(p.instrumentId);
  for (const o of paper.workingOrders()) want.add(o.instrumentId);
  for (const id of want) {
    if (kept.has(id) || /^replay/.test(id)) continue;
    try {
      hub.retain(id);
      kept.add(id);
    } catch {
      // Unknown instrument (removed provider): nothing to keep.
    }
  }
  for (const id of kept)
    if (!want.has(id)) {
      kept.delete(id);
      hub.release(id);
    }
}
paper.subscribe(keepTradedFeeds);

export function pnlTick(instrumentId: string): number {
  return paper.pnlPerTick(instrumentId);
}
