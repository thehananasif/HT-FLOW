import { registerLiveVenue } from './venue';

/** Bitfinex perpetuals and spot — free public data via crates/connectors/bitfinex (desktop app).
 * Bitfinex quotes 5 significant digits; the exchange-derived tick replaces these defaults. */
export const BITFINEX = registerLiveVenue({
  venue: 'bitfinex',
  exchange: 'Bitfinex',
  label: 'Bitfinex (live)',
  rows: [
    ['tBTCF0:USTF0', 1, 0, 6],
    ['tETHF0:USTF0', 0.1, 1, 6],
    ['tBTCUSD', 1, 0, 6, 'Spot'],
    ['tETHUSD', 0.1, 1, 6, 'Spot'],
  ],
});
