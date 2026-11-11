import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  DeribitChainSource,
  SIM_UNDERLYINGS,
  SimChainSource,
  type LiveUnderlyingQuote,
  type OptionsChain,
} from '@htflow/options';
import { isTauri } from '../../backend';
import { hub } from '../../state/market';

/** Desktop: the Rust `net_fetch_text` command (CSP blocks remote fetch); browser: window.fetch. */
export async function fetchText(url: string): Promise<string> {
  if (isTauri) {
    try {
      return await invoke<string>('net_fetch_text', { url });
    } catch {
      // Command not available in this build: fall through to fetch.
    }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function liveQuote(instrumentId: string): LiveUnderlyingQuote | null {
  const s = hub.peek(instrumentId);
  if (!s) return null;
  const tick = s.instrument.tickSize;
  const bb = s.book.bestBid;
  const ba = s.book.bestAsk;
  const last = s.lastTrade?.px;
  return {
    bid: Number.isFinite(bb) ? bb * tick : null,
    ask: Number.isFinite(ba) ? ba * tick : null,
    bidSize: Number.isFinite(bb) ? s.book.sizeAt(bb).bid : null,
    askSize: Number.isFinite(ba) ? s.book.sizeAt(ba).ask : null,
    last: last === undefined ? null : last * tick,
  };
}

export const simSource = new SimChainSource(liveQuote);
export const deribitSource = new DeribitChainSource(fetchText);

export interface UnderlyingOption {
  id: string;
  label: string;
}

export const UNDERLYINGS: UnderlyingOption[] = [
  ...SIM_UNDERLYINGS.map((u) => ({ id: u.id, label: `${u.symbol} · Sim` })),
  { id: 'deribit:BTC', label: 'BTC · Deribit' },
  { id: 'deribit:ETH', label: 'ETH · Deribit' },
];

export const isDeribit = (id: string) => id.startsWith('deribit:');

/**
 * Loads and refreshes the chain: simulated chains every second from the shared market store,
 * Deribit every 15 s (then tickers for the visible contracts via `enrich`).
 */
export function useChain(
  underlying: string,
  r: number,
  visible: (chain: OptionsChain) => string[],
): { chain: OptionsChain | null; error: string | null; loading: boolean } {
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    let alive = true;
    setChain(null);
    setError(null);
    setLoading(true);
    const deribit = isDeribit(underlying);
    if (!deribit) hub.retain(underlying);
    const tick = async () => {
      try {
        const c = deribit
          ? await deribitSource.load(underlying.slice('deribit:'.length))
          : await simSource.load(underlying, { r });
        if (!alive) return;
        setChain(c);
        setError(null);
        if (deribit) {
          await deribitSource.enrich(c, visibleRef.current(c).slice(0, 60));
          if (alive) setChain({ ...c });
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), deribit ? 15_000 : 1000);
    return () => {
      alive = false;
      clearInterval(id);
      if (!deribit) hub.release(underlying);
    };
  }, [underlying, r]);

  return { chain, error, loading };
}
