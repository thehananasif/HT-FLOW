import type { ReactNode } from 'react';

export type CommandGroup =
  | 'Platform'
  | 'Chart'
  | 'Trading'
  | 'Layout'
  | 'Analysis'
  | 'Tables'
  | 'Info'
  | 'Drawing'
  | 'Instrument'
  | 'Replay';

/**
 * Where a hotkey is active (P43). `global` fires anywhere; the others fire only when the last
 * click / focus is inside that kind of window: chart windows, the Trading panel or DOM, or any
 * element marked `data-hotkey-scope="replay"` (or `chart` / `trading`).
 */
export type HotkeyScope = 'global' | 'chart' | 'trading' | 'replay';

export const HOTKEY_SCOPES: { value: HotkeyScope; label: string }[] = [
  { value: 'global', label: 'Global' },
  { value: 'chart', label: 'Chart' },
  { value: 'trading', label: 'Trading panel' },
  { value: 'replay', label: 'Replay' },
];

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Default shortcut, e.g. "Ctrl+Shift+K". The user's override (Settings → Hot keys) wins. */
  shortcut?: string;
  /** Default hotkey scope (global when omitted). */
  scope?: HotkeyScope;
  icon?: ReactNode;
  keywords?: string;
  run(): void;
}

/** A user override for one command: `shortcut: null` unbinds it, `undefined` keeps the default. */
export interface HotkeyBinding {
  shortcut?: string | null;
  scope?: HotkeyScope;
}
export type HotkeyOverrides = Record<string, HotkeyBinding>;

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();
let overrides: HotkeyOverrides = {};
let suspended = false;

const notify = () => listeners.forEach((l) => l());

/** Every module registers its commands here: Command Palette (Ctrl+K), hotkeys and menus read it. */
export function registerCommands(cmds: Command[]): () => void {
  for (const c of cmds) registry.set(c.id, c);
  notify();
  return () => {
    for (const c of cmds) if (registry.get(c.id) === c) registry.delete(c.id);
    notify();
  };
}

/** Commands with the user's effective shortcut and scope applied (what the palette shows). */
export function commands(): Command[] {
  return [...registry.values()].map((c) => {
    const o = overrides[c.id];
    if (!o) return c;
    return { ...c, shortcut: effectiveShortcut(c.id), scope: effectiveScope(c.id) };
  });
}

/** Commands exactly as registered (default shortcuts), for the Hot keys editor. */
export function registeredCommands(): Command[] {
  return [...registry.values()];
}

export function runCommand(id: string): void {
  registry.get(id)?.run();
}

export function onCommandsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ------------------------------------------------------------------ override layer (P27 / P43)

/** Replaces the user's hotkey overrides (called by Settings when bindings are applied or loaded). */
export function setHotkeyOverrides(next: HotkeyOverrides): void {
  const clean: HotkeyOverrides = {};
  for (const [id, b] of Object.entries(next)) {
    const o: HotkeyBinding = {};
    if (b.shortcut === null) o.shortcut = null;
    else if (typeof b.shortcut === 'string' && b.shortcut)
      o.shortcut = normalizeShortcut(b.shortcut);
    if (b.scope) o.scope = b.scope;
    if (o.shortcut !== undefined || o.scope) clean[id] = o;
  }
  overrides = clean;
  notify();
}

export function hotkeyOverrides(): HotkeyOverrides {
  return overrides;
}

export function defaultShortcut(id: string): string | undefined {
  const s = registry.get(id)?.shortcut;
  return s ? normalizeShortcut(s) : undefined;
}

export function effectiveShortcut(id: string, o: HotkeyOverrides = overrides): string | undefined {
  const b = o[id];
  if (b && b.shortcut !== undefined) return b.shortcut ?? undefined;
  return defaultShortcut(id);
}

export function effectiveScope(id: string, o: HotkeyOverrides = overrides): HotkeyScope {
  return o[id]?.scope ?? registry.get(id)?.scope ?? 'global';
}

/** While true (e.g. the Hot keys editor is recording a key), installHotkeys ignores key presses. */
export function setHotkeysSuspended(v: boolean): void {
  suspended = v;
}

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];

/** Canonical "Ctrl+Alt+Shift+Key" form; letters upper-case; "Control"/"Cmd" → Ctrl, "Delete" → Del. */
export function normalizeShortcut(s: string): string {
  const raw = s.trim();
  if (!raw) return '';
  // Allow "Ctrl++" style (key is "+").
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  const mods = new Set<string>();
  let key = '';
  for (let p of parts.map((x) => x.trim()).filter(Boolean)) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmd' || l === 'meta') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else {
      if (l === 'delete') p = 'Del';
      else if (l === 'space' || p === ' ') p = 'Space';
      else if (l === 'esc') p = 'Escape';
      else if (p.length === 1) p = p.toUpperCase();
      else if (/^f\d{1,2}$/.test(l)) p = l.toUpperCase();
      key = p;
    }
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), ...(key ? [key] : [])].join('+');
}

/** Normalises a KeyboardEvent to "Ctrl+Shift+K" form. */
export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  // Physical letter/digit keys: layout- and Shift-independent ("Shift+1", not "Shift+!").
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) k = code.slice(3);
  else if (/^Digit\d$/.test(code)) k = code.slice(5);
  else if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(k)) parts.push(k === 'Delete' ? 'Del' : k);
  return parts.join('+');
}

/** True for a key press that is only a modifier (nothing to bind yet). */
export function isModifierOnly(e: KeyboardEvent): boolean {
  return ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);
}

const SCOPE_SELECTORS: [HotkeyScope, string][] = [
  ['chart', '[data-hotkey-scope="chart"], .chart-window'],
  ['trading', '[data-hotkey-scope="trading"], [data-testid="trading-panel"], .dom-window'],
  ['replay', '[data-hotkey-scope="replay"]'],
];

/** Scopes active for an element (always includes `global`). */
export function scopesFor(el: Element | null): Set<HotkeyScope> {
  const out = new Set<HotkeyScope>(['global']);
  if (!el || typeof el.closest !== 'function') return out;
  for (const [scope, sel] of SCOPE_SELECTORS) if (el.closest(sel)) out.add(scope);
  return out;
}

export interface BindingRow {
  id: string;
  shortcut?: string;
  scope: HotkeyScope;
}

/** Commands sharing a shortcut in overlapping scopes (global overlaps every scope). */
export function hotkeyConflicts(rows: BindingRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byKey = new Map<string, BindingRow[]>();
  for (const r of rows) {
    if (!r.shortcut) continue;
    const list = byKey.get(r.shortcut) ?? [];
    list.push(r);
    byKey.set(r.shortcut, list);
  }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    for (const a of list) {
      const others = list.filter(
        (b) => b !== a && (a.scope === b.scope || a.scope === 'global' || b.scope === 'global'),
      );
      if (others.length)
        out.set(
          a.id,
          others.map((b) => b.id),
        );
    }
  }
  return out;
}

/** Picks the command for a key press: the most specific active scope wins over global. */
export function resolveHotkey(
  sc: string,
  active: Set<HotkeyScope>,
  o: HotkeyOverrides = overrides,
): Command | undefined {
  let globalHit: Command | undefined;
  for (const c of registry.values()) {
    if (effectiveShortcut(c.id, o) !== sc) continue;
    const scope = effectiveScope(c.id, o);
    if (!active.has(scope)) continue;
    if (scope !== 'global') return c;
    globalHit ??= c;
  }
  return globalHit;
}

let activeWindowElement: () => Element | null = () => null;

/**
 * Element of the active window (dockview). When the last pointer-down was not inside any window
 * (ribbon, a closed context menu, the status bar…), window-scoped hotkeys use this window instead,
 * so Ctrl+Z / Ctrl+R / Shift+B… keep working on the chart you last used.
 */
export function setActiveWindowElement(fn: () => Element | null): void {
  activeWindowElement = fn;
}

const WINDOW_SELECTOR = '[data-window-id], .dv-groupview, [data-hotkey-scope]';

export function installHotkeys(): () => void {
  let lastPointer: Element | null = null;
  const onPointer = (e: PointerEvent) => {
    lastPointer = e.target instanceof Element ? e.target : null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (suspended || e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    const sc = eventToShortcut(e);
    if (typing && !sc.startsWith('Ctrl+')) return;
    const anchor = lastPointer?.isConnected ? lastPointer : null;
    const inWindow =
      !!anchor && typeof anchor.closest === 'function' && !!anchor.closest(WINDOW_SELECTOR);
    const active = scopesFor(inWindow ? anchor : activeWindowElement());
    for (const s of scopesFor(target instanceof Element ? target : null)) active.add(s);
    const cmd = resolveHotkey(sc, active);
    if (cmd) {
      e.preventDefault();
      cmd.run();
    }
  };
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('keydown', onKey);
  };
}
