import { registerLiveVenue } from './venue';

/** Bitget USDT-M futures — free public data via crates/connectors/bitget (desktop app). */
export const BITGET = registerLiveVenue({
  venue: 'bitget',
  exchange: 'Bitget',
  label: 'Bitget (live)',
  rows: [
    ['BTCUSDT', 0.1, 1, 3],
    ['ETHUSDT', 0.01, 2, 2],
    ['SOLUSDT', 0.001, 3, 1],
    ['XRPUSDT', 0.0001, 4, 0],
  ],
});
