import { describe, expect, it } from 'vitest';
import { OrderBook } from './orderBook';
import { MockFeed } from './mockFeed';

describe('OrderBook', () => {
  it('tracks best bid/ask through deltas', () => {
    const b = new OrderBook();
    b.applySnapshot({
      ts: 0,
      bids: [
        [99, 5],
        [98, 3],
      ],
      asks: [
        [100, 4],
        [101, 2],
      ],
    });
    expect([b.bestBid, b.bestAsk]).toEqual([99, 100]);
    b.applyDelta({ side: 'sell', px: 100, qty: 0 });
    expect(b.bestAsk).toBe(101);
    b.applyDelta({ side: 'buy', px: 100, qty: 1 });
    expect(b.bestBid).toBe(100);
    b.applyDelta({ side: 'buy', px: 100, qty: 0 });
    expect(b.bestBid).toBe(99);
    expect(b.top(1)).toEqual({ bids: [[99, 5]], asks: [[101, 2]] });
  });

  it('mirrors the simulator book exactly when fed its deltas (no drift, never crossed)', () => {
    const feed = new MockFeed('BTCUSDT', {
      seed: 3,
      historyHours: 0.05,
      depthMinutes: 1,
      now: 1_700_000_000_000,
    });
    const h = feed.historySync();
    const book = new OrderBook();
    book.applySnapshot(h.book);
    for (let i = 0; i < 400; i++) {
      const batch = feed.pump(50);
      book.applyDeltas(batch.deltas);
      expect(book.bestBid).toBeLessThan(book.bestAsk);
    }
    const truth = feed.historyBookForTest();
    expect([...book.bids.entries()].sort()).toEqual([...truth.bids].sort());
    expect([...book.asks.entries()].sort()).toEqual([...truth.asks].sort());
  });
});
