import type { Instrument } from '@htflow/market-data';
import { registerFeedProvider } from './registry';
import { createLiveFeed, liveInstruments } from '../state/liveFeed';

/** One built-in instrument row: [symbol, tick, price decimals, qty decimals]. */
export type VenueRow = [symbol: string, tick: number, pricePrecision: number, qtyPrecision: number];

export interface LiveVenue {
  /** Rust venue id, also the instrument id prefix (`okx-swap` → `okx-swap:BTC-USDT-SWAP`). */
  venue: string;
  /** Exchange name shown in pickers. */
  exchange: string;
  /** Picker group label. */
  label: string;
  rows: VenueRow[];
  /** Display suffix after the symbol ("Perpetual", "Spot", …). */
  suffix?: string;
  currency?: string;
}

/** Instruments of a live venue (exported for tests and the catalog). */
export function venueInstruments(v: LiveVenue): Instrument[] {
  return liveInstruments(`${v.venue}:`, v.exchange, v.rows, v.suffix ?? 'Perpetual').map((i) => ({
    ...i,
    currency: v.currency ?? i.currency,
  }));
}

/**
 * Registers a feed provider for a Rust connector venue (desktop only). Unknown symbols of the
 * venue are created on demand; the exchange-reported tick size replaces the defaults on load.
 */
export function registerLiveVenue(v: LiveVenue): Instrument[] {
  const prefix = `${v.venue}:`;
  const list = venueInstruments(v);
  registerFeedProvider({
    prefix,
    label: v.label,
    desktopOnly: true,
    instruments: () => list,
    create(id) {
      const symbol = id.slice(prefix.length);
      const inst = list.find((i) => i.id === id) ?? {
        ...list[0]!,
        id,
        symbol,
        displayName: symbol,
      };
      return createLiveFeed(inst, v.venue);
    },
  });
  return list;
}
