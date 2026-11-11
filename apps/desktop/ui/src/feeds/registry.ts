import type { FeedSource, Instrument } from '@htflow/market-data';

/**
 * Data-source plugins (P05). A provider owns an instrument id prefix such as `replay:` or
 * `bybit-linear:` and creates a FeedSource for it. Every `ui/src/feeds/*.ts` file except this one
 * is loaded automatically by feeds/load.ts, so new connectors register without editing shared files.
 */
export interface FeedProvider {
  prefix: string;
  /** Group label in the instrument picker, e.g. "Bybit (live)". */
  label: string;
  /** Instruments to offer in pickers (may be empty for providers created on demand). */
  instruments(): Instrument[];
  create(instrumentId: string): FeedSource;
  /** Only available inside the Windows app (needs the Rust core). */
  desktopOnly?: boolean;
}

const providers: FeedProvider[] = [];

export function registerFeedProvider(p: FeedProvider): void {
  const i = providers.findIndex((x) => x.prefix === p.prefix);
  if (i >= 0) providers[i] = p;
  else providers.push(p);
}

export function feedProviders(): FeedProvider[] {
  return providers;
}

export function providerFor(instrumentId: string): FeedProvider | undefined {
  return providers.find((p) => instrumentId.startsWith(p.prefix));
}
