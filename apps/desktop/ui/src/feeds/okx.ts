import { registerLiveVenue } from './venue';

/** OKX USDT perpetual swaps — free public data via crates/connectors/okx (desktop app). */
export const OKX_SWAP = registerLiveVenue({
  venue: 'okx-swap',
  exchange: 'OKX',
  label: 'OKX (live)',
  rows: [
    ['BTC-USDT-SWAP', 0.1, 1, 4],
    ['ETH-USDT-SWAP', 0.01, 2, 3],
    ['SOL-USDT-SWAP', 0.01, 2, 2],
    ['XRP-USDT-SWAP', 0.0001, 4, 2],
    ['DOGE-USDT-SWAP', 0.00001, 5, 0],
  ],
});
