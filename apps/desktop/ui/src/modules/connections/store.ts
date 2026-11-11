import { create } from 'zustand';
import { backend } from '../../backend';
import { useSession } from '../../state/session';
import { LIVE_VENUES, setVenueEnabled } from '../../state/liveFeed';
import {
  DEFAULT_CONNECTIONS,
  providerById,
  type ConnectionConfig,
  type ConnectionsDoc,
} from './providers';

const KEY = 'connections';

interface ConnState extends ConnectionsDoc {
  loaded: boolean;
  load(): Promise<void>;
  save(): void;
  setAutoConnect(on: boolean): void;
  upsert(c: ConnectionConfig): void;
  remove(id: string): void;
}

function sanitize(doc: Partial<ConnectionsDoc> | null): ConnectionsDoc {
  if (!doc || !Array.isArray(doc.list)) return structuredClone(DEFAULT_CONNECTIONS);
  return {
    autoConnect: doc.autoConnect !== false,
    list: doc.list.filter((c) => c && typeof c.id === 'string' && providerById(c.provider)),
  };
}

export const useConnections = create<ConnState>((set, get) => ({
  ...structuredClone(DEFAULT_CONNECTIONS),
  loaded: false,
  load: async () => {
    const doc = sanitize(await backend.loadSettings<ConnectionsDoc>(KEY).catch(() => null));
    set({ ...doc, loaded: true });
  },
  save: () => {
    const { autoConnect, list } = get();
    void backend.saveSettings(KEY, { autoConnect, list }).catch(() => undefined);
  },
  setAutoConnect: (on) => {
    set({ autoConnect: on });
    get().save();
  },
  upsert: (c) => {
    const list = get().list.filter((x) => x.id !== c.id);
    set({ list: [...list, c] });
    get().save();
  },
  remove: (id) => {
    set({ list: get().list.filter((x) => x.id !== id) });
    get().save();
  },
}));

/** The live venue a connection drives, if any. */
export function venueOf(c: ConnectionConfig): string | undefined {
  return providerById(c.provider)?.venue;
}

/**
 * Auto-connect on start: after login, live venues start connected only when "Auto-connect on
 * start" is on and their connection has "Connect on start". Venues with no connection configured
 * stay available (a chart can still open them).
 */
let applied: string | null = null;
useSession.subscribe((s) => {
  const id = s.session?.profileId ?? null;
  if (!id || applied === id) return;
  applied = id;
  void useConnections
    .getState()
    .load()
    .then(() => {
      const { autoConnect, list } = useConnections.getState();
      for (const v of LIVE_VENUES) {
        const conns = list.filter((c) => venueOf(c) === v);
        if (!conns.length) continue;
        setVenueEnabled(v, autoConnect && conns.some((c) => c.connectOnStart));
      }
    });
});
