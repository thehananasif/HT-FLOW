import { registerLiveVenue } from './venue';

/** Binance spot — free public data via crates/connectors/binance (desktop app). */
export const BINANCE_SPOT = registerLiveVenue({
  venue: 'binance-spot',
  exchange: 'Binance',
  label: 'Binance Spot (live)',
  suffix: 'Spot',
  rows: [
    ['BTCUSDT', 0.01, 2, 5],
    ['ETHUSDT', 0.01, 2, 4],
    ['SOLUSDT', 0.01, 2, 3],
    ['BNBUSDT', 0.01, 2, 3],
    ['XRPUSDT', 0.0001, 4, 0],
  ],
});

/** Binance COIN-M futures (sizes in contracts) — free public data (desktop app). */
export const BINANCE_COINM = registerLiveVenue({
  venue: 'binance-coinm',
  exchange: 'Binance',
  label: 'Binance COIN-M (live)',
  suffix: 'Inverse Perpetual',
  currency: 'USD',
  rows: [
    ['BTCUSD_PERP', 0.1, 1, 0],
    ['ETHUSD_PERP', 0.01, 2, 0],
    ['SOLUSD_PERP', 0.01, 2, 0],
    ['XRPUSD_PERP', 0.0001, 4, 0],
  ],
});
