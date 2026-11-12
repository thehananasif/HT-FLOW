import { create } from 'zustand';
import type { TabId } from './settings/schema';

/** Which chart the Chart settings window (P34) is open for. */
export const useChartSettingsUi = create<{
  openFor: string | null;
  tab: TabId;
  open(windowId: string, tab?: TabId): void;
  close(): void;
}>((set) => ({
  openFor: null,
  tab: 'visual',
  open: (windowId, tab) => set((s) => ({ openFor: windowId, tab: tab ?? s.tab })),
  close: () => set({ openFor: null }),
}));
