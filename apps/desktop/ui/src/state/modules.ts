/**
 * Custom modules (P43): which registered module windows are switched off in
 * Settings → Custom modules. The Settings window itself can never be disabled.
 */
import { getSetting } from './settings';

/** Modules that cannot be disabled (the user would lose the way back). */
export const ALWAYS_ON_MODULES = ['settings'];

export function isModuleDisabled(id: string): boolean {
  return !ALWAYS_ON_MODULES.includes(id) && getSetting('modules.disabled').includes(id);
}
