import { create } from 'zustand';
import type { WindowState } from '@htflow/workspace';

interface WindowsState {
  windows: Record<string, WindowState>;
  activeId: string | null;
  tradingPanel: boolean;
  setAll(w: Record<string, WindowState>): void;
  add(id: string, s: WindowState): void;
  remove(id: string): void;
  patch(id: string, p: Partial<WindowState>): void;
  setActive(id: string | null): void;
  setTradingPanel(open: boolean): void;
}

/** Per-window state (instrument, template, timeframe, link group…) — the source of workspace persistence. */
export const useWindows = create<WindowsState>((set, get) => ({
  windows: {},
  activeId: null,
  tradingPanel: true,
  setAll: (windows) => set({ windows }),
  add: (id, s) => set({ windows: { ...get().windows, [id]: s } }),
  remove: (id) => {
    const w = { ...get().windows };
    delete w[id];
    set({ windows: w });
  },
  patch: (id, p) => {
    const all = { ...get().windows };
    const cur = all[id];
    if (!cur) return;
    const next = { ...cur, ...p } as WindowState;
    all[id] = next;
    // Link groups: changing the instrument in one window changes every window of the same colour.
    if ('instrumentId' in p && next.kind !== 'module' && next.link !== 'none') {
      for (const [k, w] of Object.entries(all)) {
        if (k !== id && w.kind !== 'module' && w.link === next.link)
          all[k] = { ...w, instrumentId: next.instrumentId };
      }
    }
    set({ windows: all });
  },
  setActive: (id) => set({ activeId: id }),
  setTradingPanel: (open) => set({ tradingPanel: open }),
}));

export function activeInstrument(): string | null {
  const { windows, activeId } = useWindows.getState();
  const w =
    (activeId && windows[activeId]) || Object.values(windows).find((x) => x.kind !== 'module');
  return w && w.kind !== 'module' ? w.instrumentId : null;
}
