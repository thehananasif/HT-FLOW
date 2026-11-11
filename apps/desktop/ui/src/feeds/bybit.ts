import { registerFeedProvider } from './registry';
import { createLiveFeed, liveInstruments } from '../state/liveFeed';

/** Bybit v5 linear perpetuals — free public data via crates/connectors/bybit (desktop app). */
const INSTRUMENTS = liveInstruments('bybit-linear:', 'Bybit', [
  ['BTCUSDT', 0.1, 1, 3],
  ['ETHUSDT', 0.01, 2, 2],
  ['SOLUSDT', 0.01, 2, 1],
  ['XRPUSDT', 0.0001, 4, 0],
  ['DOGEUSDT', 0.00001, 5, 0],
]);

registerFeedProvider({
  prefix: 'bybit-linear:',
  label: 'Bybit (live)',
  desktopOnly: true,
  instruments: () => INSTRUMENTS,
  create(id) {
    const inst = INSTRUMENTS.find((i) => i.id === id) ?? {
      ...INSTRUMENTS[0]!,
      id,
      symbol: id.slice('bybit-linear:'.length),
      displayName: id.slice('bybit-linear:'.length),
    };
    return createLiveFeed(inst, 'bybit-linear');
  },
});
