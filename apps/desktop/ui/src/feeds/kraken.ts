import { registerLiveVenue } from './venue';

/** Kraken Futures flexible perpetuals — free public data via crates/connectors/kraken. */
export const KRAKEN_FUTURES = registerLiveVenue({
  venue: 'kraken-futures',
  exchange: 'Kraken',
  label: 'Kraken Futures (live)',
  currency: 'USD',
  rows: [
    ['PF_XBTUSD', 0.5, 1, 4],
    ['PF_ETHUSD', 0.1, 1, 3],
    ['PF_SOLUSD', 0.01, 2, 2],
    ['PF_XRPUSD', 0.0001, 4, 0],
  ],
});
