import { useSyncExternalStore } from 'react';
import { applyOrder, sanitizeRibbon, type RibbonLayout } from '@htflow/ui-kit';
import { backend } from '../backend';
import { useSession } from '../state/session';
import { MODULES } from './modules';
import { registerCommands } from './commands';

/** Persisted under `backend.saveSettings('ribbon', …)` (encrypted per profile). */
const KEY = 'ribbon';
const ALL_IDS = MODULES.map((m) => m.id);
export const RIBBON_GROUPS = [...new Set(MODULES.map((m) => m.group))];

interface State extends RibbonLayout {
  customizeOpen: boolean;
}

let state: State = { hidden: [], order: [], customizeOpen: false };
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  state = { ...state };
  listeners.forEach((l) => l());
}

function persist(): void {
  if (!loaded) return;
  // Tiny payload: save immediately (no debounce) so a quick logout cannot lose the change.
  void backend.saveSettings(KEY, { hidden: state.hidden, order: state.order });
}

export const ribbonStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  hide(id: string) {
    if (state.hidden.includes(id)) return;
    state.hidden = [...state.hidden, id];
    emit();
    persist();
  },
  setHidden(id: string, hidden: boolean) {
    const has = state.hidden.includes(id);
    if (hidden === has) return;
    state.hidden = hidden ? [...state.hidden, id] : state.hidden.filter((x) => x !== id);
    emit();
    persist();
  },
  setLayout(layout: RibbonLayout) {
    state.hidden = layout.hidden;
    state.order = layout.order;
    emit();
    persist();
  },
  reset() {
    ribbonStore.setLayout({ hidden: [], order: [] });
  },
  openCustomize(open = true) {
    state.customizeOpen = open;
    emit();
  },
};

/** Ids in display order for one group (hidden ones included). */
export function groupIds(group: string, order: readonly string[]): string[] {
  return applyOrder(
    MODULES.filter((m) => m.group === group).map((m) => m.id),
    order,
  );
}

export function useRibbonState(): State {
  return useSyncExternalStore(ribbonStore.subscribe, ribbonStore.get);
}

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  loaded = false;
  state = { hidden: [], order: [], customizeOpen: false };
  listeners.forEach((l) => l());
  if (!id) return;
  void backend.loadSettings<unknown>(KEY).then((saved) => {
    if (loadedFor !== id) return;
    const l = sanitizeRibbon(saved, ALL_IDS);
    state = { ...state, hidden: l.hidden, order: l.order };
    loaded = true;
    listeners.forEach((fn) => fn());
  });
}
useSession.subscribe(onSession);
onSession();

registerCommands([
  {
    id: 'ribbon.customize',
    label: 'Customize ribbon…',
    group: 'Layout',
    keywords: 'ribbon buttons hide show reorder toolbar',
    run: () => ribbonStore.openCustomize(true),
  },
]);
