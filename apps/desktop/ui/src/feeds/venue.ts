import type { Instrument } from '@htflow/market-data';
import { registerFeedProvider } from './registry';
import { createLiveFeed, liveInstruments } from '../state/liveFeed';
import { discoveredFeed, registerBuiltInFeeds, withDiscovered } from '../state/discovery';

/** One built-in instrument row: [symbol, tick, price decimals, qty decimals, display suffix?]. */
export type VenueRow = [
  symbol: string,
  tick: number,
  pricePrecision: number,
  qtyPrecision: number,
  suffix?: string,
];

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
  return v.rows
    .flatMap(([symbol, tick, pp, qp, suffix]) =>
      liveInstruments(
        `${v.venue}:`,
        v.exchange,
        [[symbol, tick, pp, qp]],
        suffix ?? v.suffix ?? 'Perpetual',
      ),
    )
    .map((i) => ({ ...i, currency: v.currency ?? i.currency }));
}

/**
 * Registers a feed provider for a Rust connector venue (desktop only). Unknown symbols of the
 * venue are created on demand; discovered symbols (state/discovery.ts) carry their real specs.
 */
export function registerLiveVenue(v: LiveVenue): Instrument[] {
  const prefix = `${v.venue}:`;
  const list = venueInstruments(v);
  registerBuiltInFeeds(v.venue, list);
  registerFeedProvider({
    prefix,
    label: v.label,
    desktopOnly: true,
    // Built-in rows plus every symbol the live discovery found on the venue.
    instruments: () => withDiscovered(v.venue, list),
    create(id) {
      const symbol = id.slice(prefix.length);
      const inst = withDiscovered(v.venue, list).find((i) => i.id === id) ??
        discoveredFeed(id) ?? {
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
