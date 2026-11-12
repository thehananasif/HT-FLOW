import { registerLiveVenue } from './venue';

/** WhiteBIT perpetuals and spot — free public data via crates/connectors/whitebit (desktop app). */
export const WHITEBIT = registerLiveVenue({
  venue: 'whitebit',
  exchange: 'WhiteBIT',
  label: 'WhiteBIT (live)',
  rows: [
    ['BTC_PERP', 0.1, 1, 4],
    ['ETH_PERP', 0.01, 2, 3],
    ['BTC_USDT', 0.01, 2, 6, 'Spot'],
    ['ETH_USDT', 0.01, 2, 4, 'Spot'],
  ],
});
