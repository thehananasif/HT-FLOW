import { roundTrips, type RoundTrip } from '@htflow/trading';
import { backend } from '../../backend';
import { paper, pnlTick } from '../../state/market';
import { useSession } from '../../state/session';

export type TagKind = 'setup' | 'mistake' | 'emotion' | 'custom';
export interface JournalTag {
  text: string;
  kind: TagKind;
}

export interface TripMeta {
  tags: JournalTag[];
  notes: string;
  /** 0 = unrated, 1–5 stars. */
  rating: number;
  /** Images as data URLs. */
  attachments: string[];
}

export const emptyMeta = (): TripMeta => ({ tags: [], notes: '', rating: 0, attachments: [] });

interface Saved {
  trips: RoundTrip[];
  meta: Record<string, TripMeta>;
}

const KEY = 'journal.data';
let trips: RoundTrip[] = [];
let meta: Record<string, TripMeta> = {};
const known = new Set<string>();
/** First stop price seen per entry order (the initial risk, before breakeven moves). */
const initialStop = new Map<string, number>();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function changed(persist = true): void {
  for (const l of listeners) l();
  if (!persist) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data: Saved = { trips, meta };
    void backend.saveSettings(KEY, data);
  }, 800);
}

/** Auto-imports every closed round trip from the paper engine (FIFO grouping). */
function sync(): void {
  for (const o of paper.orders.values())
    if (o.role === 'sl' && o.parentId && o.stopPx !== undefined && !initialStop.has(o.parentId))
      initialStop.set(o.parentId, o.stopPx);
  let added = false;
  for (const t of roundTrips(paper.fills, pnlTick)) {
    if (known.has(t.id)) continue;
    known.add(t.id);
    const stop = t.entryOrderId ? initialStop.get(t.entryOrderId) : undefined;
    const risk =
      stop !== undefined ? Math.abs(t.entryPx - stop) * pnlTick(t.instrumentId) * t.qty : undefined;
    trips = [...trips, risk && risk > 0 ? { ...t, risk } : t];
    added = true;
  }
  if (added) changed();
}
paper.subscribe(sync);

export const journalStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  trips: (): RoundTrip[] => trips,
  meta: (id: string): TripMeta => meta[id] ?? emptyMeta(),
  setMeta(id: string, patch: Partial<TripMeta>): void {
    meta = { ...meta, [id]: { ...(meta[id] ?? emptyMeta()), ...patch } };
    changed();
  },
  addManual(t: Omit<RoundTrip, 'id' | 'manual'>): RoundTrip {
    const trip: RoundTrip = { ...t, id: `manual-${Date.now().toString(36)}`, manual: true };
    known.add(trip.id);
    trips = [...trips, trip];
    changed();
    return trip;
  },
  /** Adds finished trips from elsewhere (e.g. backtests) with tags; known ids are skipped. */
  importTrips(list: readonly RoundTrip[], tags: JournalTag[] = []): number {
    const fresh = list.filter((t) => !known.has(t.id));
    for (const t of fresh) {
      known.add(t.id);
      if (tags.length) meta = { ...meta, [t.id]: { ...emptyMeta(), tags } };
    }
    if (fresh.length) {
      trips = [...trips, ...fresh];
      changed();
    }
    return fresh.length;
  },
  remove(id: string): void {
    trips = trips.filter((t) => t.id !== id);
    changed();
  },
  allTags(): string[] {
    const s = new Set<string>();
    for (const m of Object.values(meta)) for (const t of m.tags) s.add(t.text);
    return [...s].sort();
  },
};

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  if (!id) return;
  void backend.loadSettings<Saved>(KEY).then((s) => {
    if (!s) return;
    const fresh = trips.filter((t) => !(s.trips ?? []).some((x) => x.id === t.id));
    trips = [...(s.trips ?? []), ...fresh];
    for (const t of trips) known.add(t.id);
    meta = { ...(s.meta ?? {}), ...meta };
    changed(false);
  });
}
useSession.subscribe(onSession);
onSession();
