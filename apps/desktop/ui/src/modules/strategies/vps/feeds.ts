import type { Trade } from '@htflow/market-data';
import type { FeedSpec } from './core';

/**
 * Public (no-key) exchange trade streams the VPS runner connects to by itself. Pure helpers:
 * the URL / subscribe message per venue and a parser from one WebSocket text frame to trades
 * in integer ticks.
 */

export interface FeedEndpoint {
  url: string;
  /** Sent once after the socket opens. */
  subscribe?: string;
  /** Application-level ping (text) and its period. */
  ping?: { text: string; everyMs: number };
}

export function endpointFor(f: FeedSpec): FeedEndpoint {
  const sym = f.symbol;
  switch (f.exchange) {
    case 'binance-futures':
      return { url: `wss://fstream.binance.com/ws/${sym.toLowerCase()}@aggTrade` };
    case 'binance-spot':
      return { url: `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@aggTrade` };
    case 'bybit-linear':
    case 'bybit-spot':
      return {
        url: `wss://stream.bybit.com/v5/public/${f.exchange === 'bybit-linear' ? 'linear' : 'spot'}`,
        subscribe: JSON.stringify({ op: 'subscribe', args: [`publicTrade.${sym}`] }),
        ping: { text: JSON.stringify({ op: 'ping' }), everyMs: 20_000 },
      };
    case 'okx':
      return {
        url: 'wss://ws.okx.com:8443/ws/v5/public',
        subscribe: JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: sym }] }),
        ping: { text: 'ping', everyMs: 25_000 },
      };
  }
}

/** App instrument id → VPS feed (null when the venue has no public feed the runner supports). */
export function feedForInstrument(instrumentId: string): FeedSpec | null {
  const i = instrumentId.indexOf(':');
  if (i <= 0) return null;
  const prefix = instrumentId.slice(0, i);
  const symbol = instrumentId.slice(i + 1);
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(symbol)) return null;
  switch (prefix) {
    case 'binance-futures':
    case 'binance-spot':
    case 'bybit-linear':
    case 'bybit-spot':
      return { exchange: prefix, symbol: symbol.toUpperCase() };
    case 'okx-swap':
    case 'okx-spot':
      return { exchange: 'okx', symbol: symbol.toUpperCase() };
    default:
      return null;
  }
}

export const SUPPORTED_FEEDS =
  'Binance Futures / Spot, Bybit Linear / Spot and OKX (public trade streams)';

const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? +v : NaN);

/** Parses one frame into trades (prices in ticks of `tickSize`). Unknown frames → []. */
export function parseFrame(
  exchange: FeedSpec['exchange'],
  text: string,
  tickSize: number,
): Trade[] {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return [];
  }
  if (!m || typeof m !== 'object') return [];
  const o = m as Record<string, unknown>;
  const tick = (p: number) => Math.round(p / tickSize);
  const out: Trade[] = [];
  const push = (px: number, qty: number, ts: number, sell: boolean, id: number) => {
    if (px > 0 && qty > 0 && Number.isFinite(ts))
      out.push({ ts, px: tick(px), qty, side: sell ? 'sell' : 'buy', id });
  };
  switch (exchange) {
    case 'binance-futures':
    case 'binance-spot':
      // aggTrade: m = buyer is the maker → the aggressor sold.
      if (o.e === 'aggTrade') push(num(o.p), num(o.q), num(o.T), o.m === true, num(o.a));
      break;
    case 'bybit-linear':
    case 'bybit-spot':
      if (
        typeof o.topic === 'string' &&
        o.topic.startsWith('publicTrade.') &&
        Array.isArray(o.data)
      )
        for (const d of o.data as Record<string, unknown>[])
          push(num(d.p), num(d.v), num(d.T), d.S === 'Sell', num(d.i) || 0);
      break;
    case 'okx':
      if (
        Array.isArray(o.data) &&
        (o.arg as { channel?: string } | undefined)?.channel === 'trades'
      )
        for (const d of o.data as Record<string, unknown>[])
          push(num(d.px), num(d.sz), num(d.ts), d.side === 'sell', num(d.tradeId));
      break;
  }
  return out;
}
