/**
 * Translated display text for drawing tools. `@htflow/drawings` keeps English labels as data
 * (it does not depend on i18n); the UI layer resolves `drawings.tool.<id>`,
 * `drawings.toolDesc.<id>` and the group keys, falling back to the package's English text.
 */
import { t, type Strings } from '@htflow/i18n';
import { toolDef } from '@htflow/drawings';

/** Translate `key`, or return `fallback` when the key has no entry. */
export function tk(key: string, fallback: string): string {
  const s = t(key as keyof Strings);
  return s === key ? fallback : s;
}

/** Display name of a drawing tool (e.g. "Trend Line"). */
export function toolLabel(id: string): string {
  return tk(`drawings.tool.${id}`, toolDef(id)?.label ?? id);
}

/** Name of a tool that is listed but not built yet, e.g. "Brush (pending)". */
export function toolPendingLabel(id: string): string {
  return tk('drawings.toolPending', '{label} (pending)').replace('{label}', toolLabel(id));
}

/** One-line hint for a tool, or undefined when it has none. */
export function toolNote(id: string): string | undefined {
  return tk(`drawings.toolDesc.${id}`, toolDef(id)?.note ?? '') || undefined;
}

/** Display name of a tool group in the Objects menu (`drawings.menuGroup.<id>`). */
export function menuGroupLabel(id: string, fallback: string): string {
  return tk(`drawings.menuGroup.${id}`, fallback);
}

/** Display name of a toolbar flyout group (`drawings.toolbarGroup.<id>`). */
export function toolbarGroupLabel(id: string, fallback: string): string {
  return tk(`drawings.toolbarGroup.${id}`, fallback);
}
