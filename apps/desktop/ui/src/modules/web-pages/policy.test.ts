import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkAddress,
  hostAllowed,
  isOpenableUrl,
  normalizeAllowEntry,
  normalizeAllowList,
  parseAllowText,
  urlPermitted,
} from './policy';

describe('isOpenableUrl (scheme blocking)', () => {
  it('accepts plain http(s)', () => {
    expect(isOpenableUrl('https://example.com/a?b=1')).toBe(true);
    expect(isOpenableUrl('http://localhost:3000')).toBe(true);
  });
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'tauri://localhost/',
    'ipc://localhost/x',
    'blob:https://example.com/id',
    'about:blank',
    'htflow://x',
    'ftp://example.com',
    'example.com',
    '',
    'https://user:pw@example.com/',
    'https://user@example.com/',
  ])('rejects %s', (u) => expect(isOpenableUrl(u)).toBe(false));
});

describe('allow-list', () => {
  it('normalises entries', () => {
    expect(normalizeAllowEntry(' Example.COM ')).toBe('example.com');
    expect(normalizeAllowEntry('https://Docs.Example.com/x?y')).toBe('docs.example.com');
    expect(normalizeAllowEntry('*.example.com')).toBe('*.example.com');
    expect(normalizeAllowEntry('localhost')).toBe('localhost');
    for (const bad of ['', 'nodots', 'a..b', '-a.com', 'exa mple.com', '*.', '*example.com'])
      expect(normalizeAllowEntry(bad)).toBeNull();
    expect(normalizeAllowList(['A.com', 'a.com', 'bad'])).toEqual(['a.com']);
  });
  it('matches on label boundaries', () => {
    expect(hostAllowed('anything.org', [])).toBe(true);
    const l = ['example.com'];
    expect(hostAllowed('example.com', l)).toBe(true);
    expect(hostAllowed('WWW.Example.com.', l)).toBe(true);
    expect(hostAllowed('evilexample.com', l)).toBe(false);
    expect(hostAllowed('example.com.evil.io', l)).toBe(false);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('xexample.com', ['*.example.com'])).toBe(false);
  });
  it('combines scheme and host checks', () => {
    expect(urlPermitted('https://sub.example.com/x', ['example.com'])).toBe(true);
    expect(urlPermitted('https://other.com/', ['example.com'])).toBe(false);
    expect(urlPermitted('file:///C:/x', [])).toBe(false);
  });
  it('checkAddress explains refusals', () => {
    expect(checkAddress('example.com', [])).toEqual({ ok: true, url: 'https://example.com/' });
    expect(checkAddress('javascript:alert(1)', [])).toMatchObject({ ok: false });
    expect(checkAddress('other.com', ['example.com'])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('allow-list'),
    });
  });
  it('parses editor text', () => {
    expect(parseAllowText('a.com, *.b.com\nnope\n\nA.com')).toEqual({
      list: ['a.com', '*.b.com'],
      rejected: ['nope'],
    });
  });
});

describe('Tauri capabilities', () => {
  const cap = JSON.parse(
    readFileSync(
      new URL('../../../../src-tauri/capabilities/default.json', import.meta.url),
      'utf8',
    ),
  ) as { windows?: string[]; remote?: unknown; webviews?: string[] };
  it('grant IPC to our own windows only (main + ht-w-* OS windows), never to webpage-* windows or remote origins', () => {
    expect(cap.windows).toEqual(['main', 'ht-w-*']);
    // No pattern may match a Web Page window label (Tauri window globs: `*` = any characters).
    const matches = (glob: string, label: string) =>
      new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
        label,
      );
    for (const glob of cap.windows ?? []) {
      expect(matches(glob, 'webpage-1')).toBe(false);
      expect(matches(glob, 'webpage-abc')).toBe(false);
    }
    expect(cap.remote).toBeUndefined();
    expect(cap.webviews).toBeUndefined();
  });
});
