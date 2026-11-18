import { create } from 'zustand';
import { toast } from '@htflow/ui-kit';
import type { WindowState } from '@htflow/workspace';
import { backend } from '../backend';
import { instrumentById } from '../state/instruments';
import { useWindows } from '../state/windows';
import {
  addSnapshot,
  makeSnapshot,
  parseSnapshots,
  removeSnapshot,
  restorePatch,
  type ChartSnapshot,
} from './snapshots';

import { translateLiteral as tl } from '@htflow/i18n';
const KEY = 'chart-snapshots';

interface SnapshotState {
  list: ChartSnapshot[];
  loaded: boolean;
  load(): Promise<void>;
  update(fn: (l: ChartSnapshot[]) => ChartSnapshot[]): void;
}

/** Chart snapshots saved per profile (encrypted settings). */
export const useChartSnapshots = create<SnapshotState>((set, get) => ({
  list: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      set({ list: parseSnapshots(await backend.loadSettings<unknown>(KEY)), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  update: (fn) => {
    const list = fn(get().list);
    set({ list });
    void backend
      .saveSettings(KEY, list)
      .catch(() => toast('error', tl('Could not save chart snapshots')));
  },
}));

/** Saves the chart's current state as a snapshot. */
export function takeSnapshot(windowId: string): ChartSnapshot | null {
  const w = useWindows.getState().windows[windowId];
  if (w?.kind !== 'chart') return null;
  const sym = instrumentById(w.instrumentId)?.symbol ?? w.instrumentId.split(':').pop() ?? '';
  const snap = makeSnapshot(w, sym);
  void useChartSnapshots
    .getState()
    .load()
    .then(() => useChartSnapshots.getState().update((l) => addSnapshot(l, snap)));
  toast('success', tl('Snapshot saved'), snap.name);
  return snap;
}

export function restoreSnapshot(windowId: string, id: string): void {
  const w = useWindows.getState().windows[windowId];
  const snap = useChartSnapshots.getState().list.find((x) => x.id === id);
  if (w?.kind !== 'chart' || !snap) return;
  useWindows.getState().patch(windowId, restorePatch(w, snap) as Partial<WindowState>);
  toast('info', tl('Snapshot restored'), snap.name);
}

export function deleteSnapshot(id: string): void {
  useChartSnapshots.getState().update((l) => removeSnapshot(l, id));
}
