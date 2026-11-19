import type { OptionsData } from '@htflow/indicator-sdk';
import { optionsChain } from '@htflow/indicators';
import {
  genericSimUnderlying,
  generateSimChain,
  simUnderlying,
  type LiveUnderlyingQuote,
  type OptionsChain,
} from '@htflow/options';
import type { Instrument, MarketStore } from '@htflow/market-data';
import { deribitSource } from '../modules/options-board/useChain';

/** Where the chain of a chart instrument comes from. */
export type OptionsOrigin =
  { kind: 'deribit'; currency: 'BTC' | 'ETH' } | { kind: 'sim'; builtin: boolean };

/**
 * Deribit public options for BTC / ETH instruments of a real venue; the built-in simulated chain
 * for the demo feed's instruments that have one; a generic simulated chain (rescaled to the live
 * price) for everything else. Simulated chains are always labelled "Sim".
 */
export function optionsOriginFor(ins: Pick<Instrument, 'id' | 'symbol'>): OptionsOrigin {
  if (simUnderlying(ins.id)) return { kind: 'sim', builtin: true };
  if (!ins.id.startsWith('mock:')) {
    const m = /^(BTC|ETH)(?:[-_/.]|USD|USDT|USDC|PERP|$)/i.exec(ins.symbol);
    if (m) return { kind: 'deribit', currency: m[1]!.toUpperCase() as 'BTC' | 'ETH' };
  }
  return { kind: 'sim', builtin: false };
}

declare global {
  interface Window {
    /** Test hook: replaces the chain source (root, instrument id). */
    __HTFLOW_OPTIONS_CHAIN__?: (root: string, instrumentId: string) => Promise<OptionsChain>;
  }
}

const DERIBIT_MS = 30_000;
const SIM_MS = 3_000;

function liveQuote(store: MarketStore): LiveUnderlyingQuote {
  const tick = store.instrument.tickSize;
  const bb = store.book.bestBid;
  const ba = store.book.bestAsk;
  const last = store.lastTrade?.px;
  return {
    bid: Number.isFinite(bb) ? bb * tick : null,
    ask: Number.isFinite(ba) ? ba * tick : null,
    bidSize: Number.isFinite(bb) ? store.book.sizeAt(bb).bid : null,
    askSize: Number.isFinite(ba) ? store.book.sizeAt(ba).ask : null,
    last: last === undefined ? null : last * tick,
  };
}

/**
 * Options chain for the indicator context of one chart. Loaded lazily (`ensure`) once an options
 * indicator is on the chart, then refreshed (simulated every 3 s, Deribit every 30 s) until
 * `detach`. `data()` is undefined until the first chain arrived.
 */
export function createOptionsFeed(store: MarketStore, onChange: () => void) {
  const ins = store.instrument;
  const origin = optionsOriginFor(ins);
  let version = 0;
  let cached: OptionsData | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  let alive = true;
  let inflight = false;

  const load = async (): Promise<OptionsChain | null> => {
    const hook = typeof window !== 'undefined' ? window.__HTFLOW_OPTIONS_CHAIN__ : undefined;
    if (hook) return hook(origin.kind === 'deribit' ? origin.currency : ins.symbol, ins.id);
    if (origin.kind === 'deribit') return deribitSource.load(origin.currency);
    const live = liveQuote(store);
    const px = live.last ?? live.bid ?? live.ask;
    const u =
      simUnderlying(ins.id) ??
      (px ? genericSimUnderlying(ins.id, ins.symbol, px, ins.tickSize) : null);
    return u ? generateSimChain(u, live, Date.now()) : null;
  };

  const tick = async () => {
    if (inflight || !alive) return;
    inflight = true;
    try {
      const c = await load();
      if (!alive || !c) return;
      cached = optionsChain.chainToData(c, ++version);
      onChange();
    } catch {
      // Offline or venue error: keep the previous chain; the indicator shows its loading note.
    } finally {
      inflight = false;
    }
  };

  return {
    origin,
    /** Starts loading (once). */
    ensure(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), origin.kind === 'deribit' ? DERIBIT_MS : SIM_MS);
    },
    data(): OptionsData | undefined {
      return cached;
    },
    detach(): void {
      alive = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
