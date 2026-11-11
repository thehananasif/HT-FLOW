import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../backend';
import { registerLiveVenue } from './venue';

/** Deribit perpetuals and futures — free public data via crates/connectors/deribit (desktop app).
 * Sizes are Deribit amounts (USD for the inverse BTC/ETH contracts). */
export const DERIBIT = registerLiveVenue({
  venue: 'deribit',
  exchange: 'Deribit',
  label: 'Deribit (live)',
  currency: 'USD',
  rows: [
    ['BTC-PERPETUAL', 0.5, 1, 0],
    ['ETH-PERPETUAL', 0.05, 2, 0],
    ['SOL_USDC-PERPETUAL', 0.01, 2, 1],
  ],
});

/** One option of the live Deribit chain (prices in the underlying currency). */
export interface DeribitOption {
  instrument: string;
  expiry_ms: number;
  strike: number;
  call: boolean;
  tick_size: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  /** Mark implied volatility, percent. */
  mark_iv: number | null;
  underlying: number | null;
  open_interest: number | null;
  volume: number | null;
}

/**
 * Live options chain for `@htflow/options` (desktop app only): every active option of a currency
 * with bid / ask / mark and mark IV, sorted by expiry, strike, call before put.
 */
export async function fetchDeribitChain(currency = 'BTC'): Promise<DeribitOption[]> {
  if (!isTauri) throw new Error('The live options chain needs the desktop app');
  return invoke<DeribitOption[]>('market_options_chain', { venue: 'deribit', currency });
}
