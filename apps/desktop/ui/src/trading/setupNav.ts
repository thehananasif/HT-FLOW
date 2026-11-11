import { create } from 'zustand';
import { useWindows } from '../state/windows';

/** Tabs of the Trading setup window (module 'atm'). */
export type SetupTab = 'atm' | 'accounts' | 'confirm' | 'chart';

export const SETUP_MODULE = 'atm';

/** Tab requested from outside (Trading Panel buttons, Command Palette). */
export const useSetupNav = create<{ tab: SetupTab | null; seq: number }>(() => ({
  tab: null,
  seq: 0,
}));

/** Opens the Trading setup window on a tab (re-uses an open window). */
export function openTradingSetup(tab: SetupTab): void {
  useSetupNav.setState((s) => ({ tab, seq: s.seq + 1 }));
  const open = Object.values(useWindows.getState().windows).some(
    (w) => w.kind === 'module' && w.module === SETUP_MODULE,
  );
  if (!open)
    window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: SETUP_MODULE }));
}
