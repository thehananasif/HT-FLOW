import { describe, expect, it } from 'vitest';
import { MarketStore } from './marketStore';
import { MockFeed } from './mockFeed';

describe('lazy older history', () => {
  it('prepends simulated trades that end at the first loaded price and rebuilds bars', async () => {
    const feed = new MockFeed('mock:BTCUSDT', { historyHours: 1, now: 1_800_000_000_000 });
    const store = new MarketStore(feed.instrument);
    store.loadHistory(feed.historySync());
    store.olderLoader = (b, s, a) => feed.historyBefore(b, s, a);
    const series = store.getSeries({ kind: 'time', ms: 60_000 });
    const firstTs = store.trades[0]!.ts;
    const firstPx = store.trades[0]!.px;
    const barsBefore = series.bars.length;

    const added = await store.loadOlder(1_800_000);
    expect(added).toBeGreaterThan(0);
    expect(store.trades[added - 1]!.ts).toBeLessThan(firstTs);
    expect(store.trades[added - 1]!.px).toBe(firstPx);
    expect(store.trades[added]!.ts).toBe(firstTs);
    for (let i = 1; i < store.trades.length; i++)
      expect(store.trades[i]!.ts).toBeGreaterThanOrEqual(store.trades[i - 1]!.ts);
    expect(series.bars.length).toBeGreaterThan(barsBefore);
    expect(store.loadingOlder).toBe(false);
  });

  it('ignores trades that overlap the loaded range and marks exhaustion', async () => {
    const feed = new MockFeed('mock:BTCUSDT', { historyHours: 1, now: 1_800_000_000_000 });
    const store = new MarketStore(feed.instrument);
    store.loadHistory(feed.historySync());
    expect(store.prependTrades(store.trades.slice(0, 10))).toBe(0);
    store.olderLoader = () => Promise.resolve([]);
    expect(await store.loadOlder()).toBe(0);
    expect(store.historyExhausted).toBe(true);
  });
});
