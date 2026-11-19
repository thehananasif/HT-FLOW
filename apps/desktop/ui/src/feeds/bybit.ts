import { registerFeedProvider } from './registry';
import { createLiveFeed, liveInstruments } from '../state/liveFeed';
import { discoveredFeed, registerBuiltInFeeds, withDiscovered } from '../state/discovery';
import { registerLiveVenue } from './venue';

/** Bybit v5 linear perpetuals — free public data via crates/connectors/bybit (desktop app). */
const INSTRUMENTS = liveInstruments('bybit-linear:', 'Bybit', [
  ['BTCUSDT', 0.1, 1, 3],
  ['ETHUSDT', 0.01, 2, 2],
  ['SOLUSDT', 0.01, 2, 1],
  ['XRPUSDT', 0.0001, 4, 0],
  ['DOGEUSDT', 0.00001, 5, 0],
]);

registerBuiltInFeeds('bybit-linear', INSTRUMENTS);

registerFeedProvider({
  prefix: 'bybit-linear:',
  label: 'Bybit (live)',
  desktopOnly: true,
  instruments: () => withDiscovered('bybit-linear', INSTRUMENTS),
  create(id) {
    const inst = withDiscovered('bybit-linear', INSTRUMENTS).find((i) => i.id === id) ??
      discoveredFeed(id) ?? {
        ...INSTRUMENTS[0]!,
        id,
        symbol: id.slice('bybit-linear:'.length),
        displayName: id.slice('bybit-linear:'.length),
      };
    return createLiveFeed(inst, 'bybit-linear');
  },
});

/** Bybit v5 spot — free public data via crates/connectors/bybit (desktop app). */
export const BYBIT_SPOT = registerLiveVenue({
  venue: 'bybit-spot',
  exchange: 'Bybit',
  label: 'Bybit Spot (live)',
  suffix: 'Spot',
  rows: [
    ['BTCUSDT', 0.01, 2, 6],
    ['ETHUSDT', 0.01, 2, 5],
    ['SOLUSDT', 0.01, 2, 3],
    ['XRPUSDT', 0.0001, 4, 2],
    ['DOGEUSDT', 0.00001, 5, 1],
  ],
});

/**
 * Bybit v5 inverse (coin-margined) perpetuals — sizes are contracts of 1 USD each, so the
 * instrument currency is USD (like Binance COIN-M). Free public data (desktop app).
 */
export const BYBIT_INVERSE = registerLiveVenue({
  venue: 'bybit-inverse',
  exchange: 'Bybit',
  label: 'Bybit Inverse (live)',
  suffix: 'Inverse Perpetual',
  currency: 'USD',
  rows: [
    ['BTCUSD', 0.5, 1, 0],
    ['ETHUSD', 0.05, 2, 0],
    ['SOLUSD', 0.01, 2, 0],
    ['XRPUSD', 0.0001, 4, 0],
  ],
});
