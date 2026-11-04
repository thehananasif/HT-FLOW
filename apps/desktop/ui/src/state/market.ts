import { MarketHub, MockFeed, type FeedSource } from '@htflow/market-data';
import { PaperEngine, pnlPerTick } from '@htflow/trading';
import { isTauri } from '../backend';
import { instrumentById, LIVE_INSTRUMENTS } from './instruments';
import { TauriLiveFeed } from './liveFeed';

function createFeed(instrumentId: string): FeedSource {
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
    const i = hub.peek(id)?.instrument ?? instrumentById(id);
    return { tickSize: i?.tickSize ?? 1, tickValue: i?.tickValue ?? 0 };
  },
});

paper.createAccount({
  id: PAPER_ACCOUNT,
  name: 'Paper · ••••3505',
  startingBalance: 50_000,
  commissionPerUnit: 0.0,
});

// Every live/mock trade reaches the paper engine (Live Pipeline stage 11).
hub.onStore((store) => {
  store.onTrades((trades) => {
    for (const t of trades) paper.onTrade(store.instrument.id, t);
  });
});

export function pnlTick(instrumentId: string): number {
  const i = hub.peek(instrumentId)?.instrument ?? instrumentById(instrumentId);
  return i ? pnlPerTick({ tickSize: i.tickSize, tickValue: i.tickValue }, 1) : 1;
}
