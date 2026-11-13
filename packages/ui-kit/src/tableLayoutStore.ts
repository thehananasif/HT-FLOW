import { useSyncExternalStore } from 'react';
import { emptyLayout, type ColumnLayout, type LayoutStoreAdapter } from './tableLogic';

/**
 * Where tables keep their column layout. Without an adapter layouts live in memory; the app
 * installs one that persists them in the user's settings (per table id).
 */
let adapter: LayoutStoreAdapter | null = null;
const memory = new Map<string, ColumnLayout>();
const listeners = new Set<() => void>();
let version = 0;
const EMPTY = emptyLayout();

/** Call when the backing data changed (settings import / reset / login). */
export function notifyTableLayouts(): void {
  version++;
  listeners.forEach((l) => l());
}
export function setTableLayoutAdapter(a: LayoutStoreAdapter | null): void {
  adapter = a;
  notifyTableLayouts();
}
export function getTableLayout(id: string): ColumnLayout | undefined {
  return adapter ? adapter.get(id) : memory.get(id);
}
export function saveTableLayout(id: string, layout: ColumnLayout | null): void {
  if (adapter) adapter.set(id, layout);
  else if (layout) memory.set(id, layout);
  else memory.delete(id);
  notifyTableLayouts();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The saved layout of table `id` (re-renders on change). */
export function useTableLayout(id: string | undefined): ColumnLayout {
  useSyncExternalStore(subscribe, () => version);
  return (id ? getTableLayout(id) : undefined) ?? EMPTY;
}
