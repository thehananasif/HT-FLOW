import { describe, expect, it } from 'vitest';
import type { WindowState } from '@htflow/workspace';
import {
  detachedIds,
  diffValues,
  diffWindows,
  initialSecondary,
  isSecondaryLabel,
  newWindowLabel,
  ownerOf,
  parseBusMsg,
  reduceRegistry,
  reduceSecondary,
  remapTab,
  sanitizeEntries,
  secondaryLabelFromSearch,
  type BusMsg,
  type OsWindowEntry,
} from './windowBus';

const chart = (instrumentId: string): WindowState =>
  ({ kind: 'chart', instrumentId, link: 'red', template: 'footprint' }) as unknown as WindowState;
const session = { profileId: 'p', username: 'u', displayName: 'U', timezone: 'UTC', theme: 'dark' };
const entry = (label: string, ids: string[]): OsWindowEntry => ({
  label,
  title: label,
  kind: 'panels',
  ids,
});

describe('labels', () => {
  it('validates like the Rust side', () => {
    expect(isSecondaryLabel('ht-w-abc1')).toBe(true);
    for (const bad of ['main', 'ht-w-', 'ht-w-A', 'ht-w-a_b', 'x', 'ht-w-' + 'a'.repeat(44), 1])
      expect(isSecondaryLabel(bad)).toBe(false);
    const l = newWindowLabel(1_700_000_000_000, 0.5);
    expect(isSecondaryLabel(l)).toBe(true);
    expect(newWindowLabel(1, 0.1)).not.toBe(newWindowLabel(1, 0.1));
  });

  it('reads the ?window= route', () => {
    expect(secondaryLabelFromSearch('?window=ht-w-x1&panel=a')).toBe('ht-w-x1');
    expect(secondaryLabelFromSearch('?window=main')).toBeNull();
    expect(secondaryLabelFromSearch('')).toBeNull();
  });
});

describe('parseBusMsg', () => {
  it('drops malformed messages and unknown senders', () => {
    expect(parseBusMsg(null)).toBeNull();
    expect(parseBusMsg({ t: 'hello' })).toBeNull();
    expect(parseBusMsg({ t: 'hello', from: 'evil' })).toBeNull();
    expect(parseBusMsg({ t: 'nope', from: 'main' })).toBeNull();
    expect(
      parseBusMsg({ t: 'paper.call', from: 'ht-w-a', method: 'deleteAccount', args: [] }),
    ).toBeNull();
    expect(
      parseBusMsg({ t: 'paper.call', from: 'ht-w-a', method: 'place', args: [{}] }),
    ).not.toBeNull();
    expect(parseBusMsg({ t: 'windows', from: 'main', windows: {} })).not.toBeNull();
    expect(parseBusMsg({ t: 'windows', from: 'main', windows: [] })).toBeNull();
    expect(parseBusMsg({ t: 'settings', from: 'ht-w-a', values: { a: 1 } })).not.toBeNull();
  });
});

describe('registry reducer', () => {
  it('opens, moves windows between OS windows, and drops empty entries', () => {
    let r = reduceRegistry({}, { type: 'open', entry: entry('ht-w-a', ['c1', 'c2']) });
    expect(ownerOf(r, 'c2')).toBe('ht-w-a');
    r = reduceRegistry(r, { type: 'open', entry: entry('ht-w-b', ['c2']) });
    expect(r['ht-w-a']!.ids).toEqual(['c1']);
    expect(ownerOf(r, 'c2')).toBe('ht-w-b');
    expect([...detachedIds(r)].sort()).toEqual(['c1', 'c2']);
    r = reduceRegistry(r, { type: 'remove-windows', ids: ['c2'] });
    expect(r['ht-w-b']).toBeUndefined();
    const same = reduceRegistry(r, { type: 'remove-windows', ids: ['zzz'] });
    expect(same).toBe(r);
    r = reduceRegistry(r, { type: 'layout', label: 'ht-w-a', layout: { x: 1 }, title: 'T' });
    expect(r['ht-w-a']).toMatchObject({ layout: { x: 1 }, title: 'T' });
    r = reduceRegistry(r, { type: 'closed', label: 'ht-w-a' });
    expect(r).toEqual({});
    expect(reduceRegistry(r, { type: 'open', entry: entry('main', ['x']) })).toBe(r);
  });

  it('resets from saved entries, validating them', () => {
    const windows = { c1: chart('a'), c2: chart('b') };
    const saved = sanitizeEntries(
      [
        { label: 'ht-w-a', title: 'A', ids: ['c1', 'gone'], kind: 'panels' },
        { label: 'ht-w-a', title: 'dup', ids: ['c2'] },
        { label: 'bad label', ids: ['c2'] },
        { label: 'ht-w-b', ids: ['gone'] },
        { label: 'ht-w-c', ids: ['c2'], kind: 'workspace', workspaceId: 'w1', layout: { p: 1 } },
        'junk',
      ],
      windows,
    );
    expect(saved).toEqual([
      { label: 'ht-w-a', title: 'A', kind: 'panels', ids: ['c1'] },
      {
        label: 'ht-w-c',
        title: 'HT Flow',
        kind: 'workspace',
        ids: ['c2'],
        layout: { p: 1 },
        workspaceId: 'w1',
      },
    ]);
    expect(Object.keys(reduceRegistry({}, { type: 'reset', entries: saved }))).toEqual([
      'ht-w-a',
      'ht-w-c',
    ]);
    expect(sanitizeEntries(undefined, windows)).toEqual([]);
  });
});

describe('sync helpers', () => {
  it('diffs window states deeply (no echo of equal states)', () => {
    const a = { c1: chart('x'), c2: chart('y') };
    const b = { c1: chart('x'), c3: chart('z') };
    expect(diffWindows(a, b)).toEqual({ changed: { c3: b.c3 }, removed: ['c2'] });
    expect(diffWindows(a, b, new Set(['c1']))).toEqual({ changed: {}, removed: [] });
    expect(diffValues({ a: 1, b: [1] }, { a: 1, b: [2], c: 'x' })).toEqual({ b: [2], c: 'x' });
  });
});

describe('secondary reducer', () => {
  const init: BusMsg = {
    t: 'init',
    from: 'main',
    to: 'ht-w-a',
    session,
    entry: entry('ht-w-a', ['c1']),
    windows: { c1: chart('x'), c9: chart('other') },
    settings: {},
    paper: [],
  };

  it('keeps only its own windows and follows main-window updates', () => {
    let s = initialSecondary('ht-w-a');
    expect(reduceSecondary(s, { ...init, to: 'ht-w-b' })).toBe(s);
    s = reduceSecondary(s, init);
    expect(s.phase).toBe('ready');
    expect(Object.keys(s.windows)).toEqual(['c1']);

    const upd = reduceSecondary(s, {
      t: 'windows',
      from: 'main',
      windows: { c1: chart('y'), c9: chart('q') },
    });
    expect((upd.windows.c1 as { instrumentId: string }).instrumentId).toBe('y');
    expect(upd.windows.c9).toBeUndefined();
    // Same values / other windows / own echoes: unchanged object.
    expect(reduceSecondary(upd, { t: 'windows', from: 'main', windows: { c1: chart('y') } })).toBe(
      upd,
    );
    expect(reduceSecondary(upd, { t: 'windows', from: 'ht-w-a', windows: {} })).toBe(upd);
    const rm = reduceSecondary(upd, { t: 'windows', from: 'main', windows: {}, removed: ['c1'] });
    expect(rm.windows).toEqual({});
    expect(reduceSecondary(rm, { t: 'close', from: 'main', to: 'ht-w-a' }).phase).toBe('closing');
  });
});

describe('remapTab', () => {
  it('gives windows new ids and rewrites the layout', () => {
    const layout = {
      grid: { root: { data: [{ views: ['c1', 'c2'], activeView: 'c1' }] } },
      panels: { c1: { id: 'c1', title: 'c1 chart' }, c2: { id: 'c2' } },
    };
    let n = 0;
    const r = remapTab(layout, { c1: chart('a'), c2: chart('b') }, () => `n${n++}`);
    expect(Object.keys(r.windows)).toEqual(['n0', 'n1']);
    expect(r.layout).toEqual({
      grid: { root: { data: [{ views: ['n0', 'n1'], activeView: 'n0' }] } },
      panels: { n0: { id: 'n0', title: 'c1 chart' }, n1: { id: 'n1' } },
    });
    expect(remapTab(null, {}, (x) => x).layout).toBeNull();
  });
});
