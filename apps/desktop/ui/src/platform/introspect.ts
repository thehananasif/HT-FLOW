import { MODULES } from '../shell/modules';
import { commands, runCommand } from '../shell/commands';
import { isModuleBuilt } from '../modules/registry';
import { SECTIONS } from '../state/settings';
import { useWindows } from '../state/windows';

/**
 * Read-only introspection for the "click everything" crawlers (Playwright
 * `e2e/click-everything.spec.ts` and the native WebdriverIO smoke test `e2e-native/`). It exposes
 * what the registries already know (ribbon modules, Command Palette commands, Settings sections)
 * so the tests enumerate controls from the source of truth instead of a hand-written list.
 * Nothing here reads user data, secrets or profile contents; `runCommand` is exactly what the
 * Command Palette does.
 */
export interface Introspection {
  version: 1;
  modules(): { id: string; label: string; group: string; built: boolean; hasMenu: boolean }[];
  commands(): { id: string; label: string; group: string; shortcut?: string }[];
  runCommand(id: string): void;
  settingsSections(): { id: string; label: string }[];
  /** Number of module / chart / DOM windows in the current layout. */
  windowCount(): number;
}

declare global {
  interface Window {
    __HTFLOW_INTROSPECT__?: Introspection;
  }
}

/** Chart and Smart DOM are built into the dashboard, not the module registry. */
const BUILT_IN = new Set(['chart', 'smart-dom']);

export const introspection: Introspection = {
  version: 1,
  modules: () =>
    MODULES.map((m) => ({
      id: m.id,
      label: m.label,
      group: m.group,
      built: BUILT_IN.has(m.id) || isModuleBuilt(m.id),
      hasMenu: !!m.hasMenu,
    })),
  commands: () =>
    commands().map((c) => ({ id: c.id, label: c.label, group: c.group, shortcut: c.shortcut })),
  runCommand: (id) => runCommand(id),
  settingsSections: () => SECTIONS.map((s) => ({ id: s.id, label: s.label })),
  windowCount: () => Object.keys(useWindows.getState().windows).length,
};

export function installIntrospection(): void {
  if (typeof window !== 'undefined') window.__HTFLOW_INTROSPECT__ = introspection;
}
