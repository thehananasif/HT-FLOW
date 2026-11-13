import { describe, expect, it } from 'vitest';
import { MOCK_INSTRUMENTS } from '@htflow/market-data';
import { providerOf, rankFeeds, type FeedRef } from './instruments';
import { fromWireProgress } from './liveFeed';

const inst = MOCK_INSTRUMENTS[0]!.instrument;
const ref = (id: string, kind: FeedRef['kind']): FeedRef => ({
  id,
  kind,
  label: id,
  instrument: inst,
});

describe('provider priority (Settings → Data)', () => {
  const feeds = [
    ref('mock:BTCUSDT', 'sim'),
    ref('bybit-linear:BTCUSDT', 'live'),
    ref('binance-futures:BTCUSDT', 'live'),
    ref('okx-swap:BTC-USDT-SWAP', 'live'),
  ];
  const ids = (l: FeedRef[]) => l.map((f) => providerOf(f.id));

  it('orders by the list, connected providers first', () => {
    expect(providerOf('okx-swap:BTC-USDT-SWAP')).toBe('okx-swap');
    expect(ids(rankFeeds(feeds, ['bybit-linear', 'binance-futures', 'okx-swap', 'mock']))).toEqual([
      'bybit-linear',
      'binance-futures',
      'okx-swap',
      'mock',
    ]);
    expect(ids(rankFeeds(feeds, ['mock', 'binance-futures', 'bybit-linear', 'okx-swap']))[0]).toBe(
      'mock',
    );
    // A disconnected venue drops behind every connected one.
    const r = rankFeeds(feeds, ['bybit-linear', 'binance-futures'], (p) => p !== 'bybit-linear');
    expect(ids(r)[0]).toBe('binance-futures');
    expect(ids(r).at(-1)).toBe('bybit-linear');
  });

  it('puts providers missing from a saved list before the simulator', () => {
    const r = rankFeeds(feeds, ['binance-futures', 'bybit-linear', 'replay', 'mock']);
    expect(ids(r)).toEqual(['binance-futures', 'bybit-linear', 'okx-swap', 'mock']);
    // Empty list: live before sim.
    expect(ids(rankFeeds(feeds, [])).at(-1)).toBe('mock');
  });

  it('maps native progress', () => {
    expect(
      fromWireProgress({
        done_ms: 1,
        total_ms: 2,
        trades: 3,
        pages: 4,
        phase: 'klines',
        throttled: true,
      }),
    ).toEqual({ doneMs: 1, totalMs: 2, trades: 3, phase: 'klines', throttled: true });
  });
});
