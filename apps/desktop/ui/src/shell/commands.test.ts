import { afterEach, describe, expect, it } from 'vitest';
import {
  commands,
  effectiveShortcut,
  hotkeyConflicts,
  normalizeShortcut,
  registerCommands,
  resolveHotkey,
  setHotkeyOverrides,
  type Command,
} from './commands';

const ran: string[] = [];
const cmd = (id: string, shortcut?: string, scope?: Command['scope']): Command => ({
  id,
  label: id,
  group: 'Platform',
  shortcut,
  scope,
  run: () => ran.push(id),
});

afterEach(() => {
  setHotkeyOverrides({});
  ran.length = 0;
});

describe('shortcut normalisation', () => {
  it('orders modifiers and upper-cases keys', () => {
    expect(normalizeShortcut('shift+ctrl+k')).toBe('Ctrl+Shift+K');
    expect(normalizeShortcut('Control+Delete')).toBe('Ctrl+Del');
    expect(normalizeShortcut('f12')).toBe('F12');
    expect(normalizeShortcut('Ctrl+,')).toBe('Ctrl+,');
  });
});

describe('override layer', () => {
  it('overrides change the effective binding, palette display and dispatch', () => {
    const un = registerCommands([cmd('a', 'T'), cmd('b', 'H')]);
    const g = new Set(['global'] as const);
    expect(resolveHotkey('T', g)?.id).toBe('a');
    setHotkeyOverrides({ a: { shortcut: 'Shift+P' } });
    expect(effectiveShortcut('a')).toBe('Shift+P');
    expect(resolveHotkey('T', g)).toBeUndefined();
    expect(resolveHotkey('Shift+P', g)?.id).toBe('a');
    expect(commands().find((c) => c.id === 'a')?.shortcut).toBe('Shift+P');
    setHotkeyOverrides({ b: { shortcut: null } });
    expect(resolveHotkey('H', g)).toBeUndefined();
    un();
  });

  it('scoped bindings only fire in their scope and win over global', () => {
    const un = registerCommands([cmd('g', 'B'), cmd('c', 'B', 'chart')]);
    expect(resolveHotkey('B', new Set(['global']))?.id).toBe('g');
    expect(resolveHotkey('B', new Set(['global', 'chart']))?.id).toBe('c');
    un();
  });

  it('detects conflicts in overlapping scopes only', () => {
    const c = hotkeyConflicts([
      { id: 'a', shortcut: 'T', scope: 'global' },
      { id: 'b', shortcut: 'T', scope: 'chart' },
      { id: 'x', shortcut: 'F', scope: 'chart' },
      { id: 'y', shortcut: 'F', scope: 'trading' },
    ]);
    expect(c.get('a')).toEqual(['b']);
    expect(c.get('b')).toEqual(['a']);
    expect(c.has('x')).toBe(false);
  });
});
