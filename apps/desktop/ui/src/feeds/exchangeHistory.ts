import { Channel, invoke } from '@tauri-apps/api/core';
import type { Instrument, Trade } from '@htflow/market-data';
import {
  DeltaLog,
  type ReplayDataInfo,
  type ReplayDataSource,
  type ReplayDataset,
  type ReplayLayers,
} from '@htflow/replay';
import { isTauri } from '../backend';
import { instrumentById } from '../state/instruments';
import { fromWireProgress, LIVE_VENUES, toTrades, type WireProgress } from '../state/liveFeed';
import { registerReplaySource } from './replay';

/**
 * Replay data straight from the exchange (P24 "missing-data download"): when nothing was recorded
 * locally, the range is fetched with the same native backfill the charts use for "Load days"
 * (`market_history_range`: tick store, history cache, REST trades for the last day, klines for
 * anything older). Preferred only when no local source covers the requested range.
 */
export interface HistoryFetchRequest {
  venue: string;
  symbol: string;
  from: number;
  to: number;
  onProgress?: (fraction: number) => void;
}
export type HistoryFetcher = (req: HistoryFetchRequest) => Promise<Trade[]>;

type RangeAnswer = { trades: [number, number, number, number, number][] };

const tauriFetcher: HistoryFetcher = async (r) => {
  const ch = new Channel<WireProgress>();
  ch.onmessage = (p) => {
    const w = fromWireProgress(p);
    r.onProgress?.(w.totalMs > 0 ? Math.min(1, w.doneMs / w.totalMs) : 0);
  };
  const a = await invoke<RangeAnswer>('market_history_range', {
    venue: r.venue,
    symbol: r.symbol,
    fromMs: Math.floor(r.from),
    toMs: Math.floor(r.to),
    progress: ch,
  });
  return toTrades(a.trades);
};

declare global {
  /** Browser preview / tests: stands in for the native backfill (no exchange access there). */
  var __HTFLOW_REPLAY_HISTORY__: HistoryFetcher | undefined;
}

function fetcher(): HistoryFetcher | null {
  return globalThis.__HTFLOW_REPLAY_HISTORY__ ?? (isTauri ? tauriFetcher : null);
}

/** True when exchange history can be fetched (desktop, or a stand-in in the browser preview). */
export function exchangeHistoryAvailable(): boolean {
  return fetcher() !== null;
}

const venueOf = (id: string): string | null => {
  const v = id.split(':')[0] ?? '';
  return (LIVE_VENUES as readonly string[]).includes(v) ? v : null;
};

const DAY = 86_400_000;
/** How far back the exchange history reaches (trades for the last day, klines before). */
export const EXCHANGE_HISTORY_DAYS = 30;

export class ExchangeHistorySource implements ReplayDataSource {
  readonly id = 'exchange';
  readonly label = 'Exchange history (downloaded)';

  constructor(private now: () => number = Date.now) {}

  covers(instrumentId: string): boolean {
    return venueOf(instrumentId) !== null && exchangeHistoryAvailable();
  }

  range(instrumentId: string): Promise<{ from: number; to: number } | null> {
    if (!this.covers(instrumentId)) return Promise.resolve(null);
    const to = this.now();
    return Promise.resolve({ from: to - EXCHANGE_HISTORY_DAYS * DAY, to });
  }

  info(instrumentId: string, from: number, to: number): Promise<ReplayDataInfo> {
    const spanMin = Math.max(0, to - from) / 60_000;
    // Real trades in the last day (~60 / min on a liquid perpetual), bar-level ticks before it.
    const recent = Math.min(spanMin, (this.now() - from) / 60_000, 1440);
    const trades = Math.round(Math.max(0, recent) * 60 + Math.max(0, spanMin - recent) * 4);
    return Promise.resolve({
      where: 'exchange',
      bytes: trades * 48,
      days: EXCHANGE_HISTORY_DAYS,
      trades,
      note: 'Last 24 h as real trades, older as bar-level ticks (no depth)',
    });
  }

  async load(
    instrumentId: string,
    from: number,
    to: number,
    layers: ReplayLayers = { ticks: true, depth: false },
    onProgress?: (p: number) => void,
  ): Promise<ReplayDataset> {
    const venue = venueOf(instrumentId);
    const f = fetcher();
    if (!venue || !f) throw new Error(`No exchange history available for ${instrumentId}`);
    const base = instrumentById(instrumentId);
    const symbol = base?.symbol ?? instrumentId.slice(instrumentId.indexOf(':') + 1);
    const got = await f({ venue, symbol, from, to, onProgress });
    const trades = got.filter((t) => t.ts >= from && t.ts <= to).sort((a, b) => a.ts - b.ts);
    if (!trades.length)
      throw new Error(
        `The exchange returned no trades for ${symbol} in that range. Try a more recent range.`,
      );
    onProgress?.(1);
    const instrument: Instrument = base ?? {
      id: instrumentId,
      symbol,
      displayName: symbol,
      exchange: venue,
      assetClass: 'crypto',
      tickSize: 0.1,
      pricePrecision: 1,
      qtyPrecision: 3,
      tickValue: 0,
      currency: 'USDT',
    };
    return {
      instrument,
      start: from,
      end: Math.max(from + 1, Math.min(to, trades[trades.length - 1]!.ts)),
      trades: layers.ticks ? trades : [],
      snapshots: [],
      deltas: new DeltaLog(1).trim(),
    };
  }
}

registerReplaySource(new ExchangeHistorySource(), false);
