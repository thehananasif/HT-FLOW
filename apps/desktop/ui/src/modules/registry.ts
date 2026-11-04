import type { ComponentType } from 'react';
import type { ModuleWindowState } from '@htflow/workspace';

/** Props every module window receives. */
export interface ModuleViewProps {
  /** dockview panel id (also the key in the windows store). */
  windowId: string;
  state: ModuleWindowState;
  /** Persists module params into the workspace (merged). */
  setParams(patch: Record<string, unknown>): void;
}

export interface ModuleRegistration {
  /** Must match a ribbon module id in shell/modules.ts, or be a new id (then label is required). */
  id: string;
  label?: string;
  view: ComponentType<ModuleViewProps>;
}

const views = new Map<string, ModuleRegistration>();

/**
 * Module windows register themselves here. Every `ui/src/modules/<name>/index.tsx` file is loaded
 * automatically by modules/load.ts, so adding a module never requires editing shared files.
 */
export function registerModule(reg: ModuleRegistration): void {
  views.set(reg.id, reg);
}

export function moduleView(id: string): ModuleRegistration | undefined {
  return views.get(id);
}

export function isModuleBuilt(id: string): boolean {
  return views.has(id);
}

export function registeredModules(): ModuleRegistration[] {
  return [...views.values()];
}
