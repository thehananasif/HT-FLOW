import { useEffect, useMemo, useState } from 'react';
import type { MarketStore } from '@htflow/market-data';
import { hub } from '../state/market';

/** Shared store for an instrument, retained for the lifetime of the window. */
export function useMarketStore(instrumentId: string): MarketStore {
  const store = useMemo(() => hub.ensure(instrumentId), [instrumentId]);
  useEffect(() => {
    hub.retain(instrumentId);
    return () => hub.release(instrumentId);
  }, [instrumentId]);
  return store;
}

/** Re-renders at most `hz` times per second while the store changes (for React-side readouts). */
export function useStoreTicker(store: MarketStore, hz = 4): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let pending = false;
    const id = setInterval(() => {
      if (pending) {
        pending = false;
        setV((x) => x + 1);
      }
    }, 1000 / hz);
    const unsub = store.subscribe(() => (pending = true));
    return () => {
      clearInterval(id);
      unsub();
    };
  }, [store, hz]);
  return v;
}
