import { registerLiveVenue } from './venue';

/** Phemex USDT perpetuals (hedged contracts) — free public data via crates/connectors/phemex. */
export const PHEMEX = registerLiveVenue({
  venue: 'phemex',
  exchange: 'Phemex',
  label: 'Phemex (live)',
  rows: [
    ['BTCUSDT', 0.1, 1, 3],
    ['ETHUSDT', 0.01, 2, 2],
    ['SOLUSDT', 0.01, 2, 1],
  ],
});
