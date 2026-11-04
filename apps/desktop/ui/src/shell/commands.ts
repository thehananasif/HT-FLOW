import type { ReactNode } from 'react';

export interface Command {
  id: string;
  label: string;
  group:
    | 'Platform'
    | 'Chart'
    | 'Trading'
    | 'Layout'
    | 'Analysis'
    | 'Tables'
    | 'Info'
    | 'Drawing'
    | 'Instrument';
  shortcut?: string;
  icon?: ReactNode;
  keywords?: string;
  run(): void;
}

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

/** Every module registers its commands here: Command Palette (Ctrl+K), hotkeys and menus read it. */
export function registerCommands(cmds: Command[]): () => void {
  for (const c of cmds) registry.set(c.id, c);
  listeners.forEach((l) => l());
  return () => {
    for (const c of cmds) registry.delete(c.id);
    listeners.forEach((l) => l());
  };
}

export function commands(): Command[] {
  return [...registry.values()];
}

export function runCommand(id: string): void {
  registry.get(id)?.run();
}

export function onCommandsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Normalises a KeyboardEvent to "Ctrl+Shift+K" form. */
export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(k)) parts.push(k === 'Delete' ? 'Del' : k);
  return parts.join('+');
}

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    const sc = eventToShortcut(e);
    if (typing && !sc.startsWith('Ctrl+')) return;
    const cmd = [...registry.values()].find((c) => c.shortcut === sc);
    if (cmd) {
      e.preventDefault();
      cmd.run();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
