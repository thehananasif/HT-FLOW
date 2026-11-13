import type { FeedStatus, Instrument } from '@htflow/market-data';
import { registerFeedProvider } from './registry';
import { useConnections } from '../modules/connections/store';
import { instrumentOf } from '../modules/connections/customWs';
import { CustomWsFeed } from '../modules/connections/customWsFeed';

/**
 * "Custom WebSocket" connections (P05). Instrument ids are `custom-ws:<connectionId>:<symbol>`;
 * the connection (URL, subscribe message, mapping) comes from the Connections store. The desktop
 * app relays the socket through the Rust core (`custom_ws_*` commands, see nativeWs.ts) because
 * the webview CSP blocks ws(s); the web build uses the browser WebSocket.
 */
export const CUSTOM_WS_PREFIX = 'custom-ws:';

const feeds = new Map<string, Set<CustomWsFeed>>();
const disabled = new Set<string>();

function configs() {
  return useConnections
    .getState()
    .list.filter((c) => c.provider === 'custom-ws' && c.ws)
    .map((c) => ({ c, ws: c.ws! }));
}

export function customWsInstruments(): Instrument[] {
  return configs().map(({ c, ws }) => instrumentOf(c.id, ws));
}

/** Connections window state for one custom connection. */
export function customWsState(connectionId: string): {
  enabled: boolean;
  feeds: number;
  status: FeedStatus | null;
} {
  const set = feeds.get(connectionId);
  const list = [...(set ?? [])];
  const live = list.find((f) => f.status.state === 'live');
  const any = live ?? list[0];
  return {
    enabled: !disabled.has(connectionId),
    feeds: list.length,
    status: any?.status ?? null,
  };
}

export function setCustomWsEnabled(connectionId: string, on: boolean): void {
  if (on) disabled.delete(connectionId);
  else disabled.add(connectionId);
  for (const f of feeds.get(connectionId) ?? []) f.setEnabled(on);
}

registerFeedProvider({
  prefix: CUSTOM_WS_PREFIX,
  label: 'Custom WebSocket',
  instruments: customWsInstruments,
  create(id) {
    const [, connId = '', ...rest] = id.split(':');
    const symbol = rest.join(':');
    const found = configs().find(
      ({ c, ws }) => c.id === connId && (!symbol || ws.symbol === symbol),
    );
    if (!found) throw new Error(`Custom WebSocket connection ${connId} no longer exists`);
    const feed = new CustomWsFeed(connId, found.ws);
    feed.setEnabled(!disabled.has(connId));
    let set = feeds.get(connId);
    if (!set) feeds.set(connId, (set = new Set()));
    set.add(feed);
    const stop = feed.stop.bind(feed);
    feed.stop = () => {
      stop();
      feeds.get(connId)?.delete(feed);
    };
    return feed;
  },
});
