import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  WORKSPACE_FILE_VERSION,
  parseWorkspaceFile,
  parseWorkspaceValue,
  safeJson,
  serializeWorkspaceFile,
  specsFromWindows,
  validateLayout,
  validateWindow,
  workspaceFileName,
  type StoredWorkspace,
} from './file';
import { chartState, domState, type WorkspaceDoc } from './model';
import { STARTER_WORKSPACES } from './starters';

const NOW = 1_800_000_000_000;

function layoutFor(ids: string[], kinds: Record<string, string>) {
  return {
    grid: {
      root: {
        type: 'branch',
        data: ids.map((id) => ({ type: 'leaf', data: { views: [id], activeView: id, id: `g-${id}` }, size: 100 })),
        size: 400,
      },
      width: 800,
      height: 400,
      orientation: 'HORIZONTAL',
    },
    panels: Object.fromEntries(ids.map((id) => [id, { id, contentComponent: kinds[id], title: id }])),
  };
}

function sampleDoc(): WorkspaceDoc {
  const windows = {
    'chart-1': chartState('mock:ESZ6', 'footprint', { link: 'blue', ext: { drawings: { items: [] } } }),
    'dom-1': domState('mock:ESZ6', { link: 'blue' }),
    'mod-1': { kind: 'module' as const, module: 'smart-tape', params: { instrumentId: 'mock:ESZ6' } },
  };
  return {
    version: 1,
    name: 'My desk',
    activeTab: 't1',
    savedAt: NOW,
    tabs: [
      {
        id: 't1',
        name: 'Main',
        layout: layoutFor(Object.keys(windows), { 'chart-1': 'chart', 'dom-1': 'dom', 'mod-1': 'module' }),
        windows,
        tradingPanel: true,
      },
    ],
  };
}

function sample(): StoredWorkspace {
  return {
    meta: {
      id: 'ws-1',
      name: 'My desk',
      description: 'ES scalping',
      favourite: true,
      createdAt: NOW - 1000,
      updatedAt: NOW,
    },
    doc: sampleDoc(),
  };
}

describe('.htworkspace round trip', () => {
  it('serialises and parses back identically', () => {
    const ws = sample();
    const text = serializeWorkspaceFile(ws, NOW);
    expect(JSON.parse(text).version).toBe(WORKSPACE_FILE_VERSION);
    const r = parseWorkspaceFile(text, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(WORKSPACE_FILE_VERSION);
    expect(r.warnings).toEqual([]);
    expect(r.workspace).toEqual(ws);
  });

  it('accepts a byte-order mark', () => {
    const r = parseWorkspaceFile('﻿' + serializeWorkspaceFile(sample(), NOW), NOW);
    expect(r.ok).toBe(true);
  });

  it('every starter workspace is a valid file', () => {
    for (const s of STARTER_WORKSPACES) {
      const ws: StoredWorkspace = {
        meta: { id: s.id, name: s.name, description: s.description, favourite: false, createdAt: 0, updatedAt: 0 },
        doc: s.build(),
      };
      const r = parseWorkspaceFile(serializeWorkspaceFile(ws, NOW), NOW);
      expect(r.ok, s.id).toBe(true);
      if (r.ok) expect(r.workspace.doc.tabs[0]!.specs?.length).toBeGreaterThan(0);
    }
  });
});

describe('migrations', () => {
  it('v1: a raw app document (the per-user autosave) imports and gets meta', () => {
    const r = parseWorkspaceValue(sampleDoc(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(1);
    expect(r.workspace.meta.name).toBe('My desk');
    expect(r.workspace.meta.createdAt).toBe(NOW);
    expect(r.workspace.meta.id).toMatch(/^ws-/);
    expect(r.workspace.doc.tabs[0]!.windows['chart-1']).toMatchObject({ template: 'footprint' });
  });

  it('v2: envelope with top-level description / favourite and monitors moves to meta + display', () => {
    const doc = {
      ...sampleDoc(),
      mainWindow: { x: 0, y: 0, width: 1920, height: 1080 },
      monitors: [{ name: 'DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, primary: true }],
    };
    const r = parseWorkspaceValue(
      { format: 'htworkspace', version: 2, description: 'old', favourite: true, workspace: doc },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(2);
    expect(r.workspace.meta).toMatchObject({ description: 'old', favourite: true, name: 'My desk' });
    expect(r.workspace.doc.display?.main.width).toBe(1920);
    expect(r.workspace.doc.display?.monitors[0]).toMatchObject({ name: 'DISPLAY1', primary: true, scale: 1 });
    expect((r.workspace.doc as unknown as Record<string, unknown>).mainWindow).toBeUndefined();
  });

  it('rejects files from a newer version and unknown formats', () => {
    const newer = parseWorkspaceValue({ format: 'htworkspace', version: 99, workspace: {} });
    expect(newer).toMatchObject({ ok: false });
    if (!newer.ok) expect(newer.error).toMatch(/newer HT Flow/);
    expect(parseWorkspaceValue({ format: 'htworkspace', version: 0 })).toMatchObject({ ok: false });
    expect(parseWorkspaceValue({ format: 'other', version: 3 })).toMatchObject({ ok: false });
    expect(parseWorkspaceValue([1, 2, 3])).toMatchObject({ ok: false });
  });
});

describe('hostile files', () => {
  const wrap = (doc: unknown) =>
    JSON.stringify({ format: 'htworkspace', version: 3, workspace: { meta: { name: 'x' }, doc } });

  it('rejects garbage, empty and over-size input', () => {
    expect(parseWorkspaceFile('not json')).toEqual({ ok: false, error: 'The file is not valid JSON' });
    expect(parseWorkspaceFile('')).toMatchObject({ ok: false });
    expect(parseWorkspaceFile('null')).toMatchObject({ ok: false });
    expect(parseWorkspaceFile(' '.repeat(LIMITS.fileBytes + 1))).toMatchObject({
      ok: false,
      error: 'The file is larger than 5 MB',
    });
  });

  it('does not pollute prototypes', () => {
    const text =
      '{"format":"htworkspace","version":3,"__proto__":{"polluted":1},"workspace":{"meta":{"name":"p","constructor":{"prototype":{"bad":1}}},"doc":' +
      JSON.stringify(sampleDoc()).replace('{"version":1', '{"__proto__":{"isAdmin":true},"version":1') +
      '}}';
    const r = parseWorkspaceFile(text, NOW);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
    if (r.ok) expect(Object.getPrototypeOf(r.workspace.doc)).toBe(Object.prototype);
  });

  it('rejects deeply nested values without overflowing the stack', () => {
    const deep = '['.repeat(5000) + ']'.repeat(5000);
    expect(parseWorkspaceFile(deep)).toMatchObject({ ok: false });
    let nested: unknown = 1;
    for (let i = 0; i < 100; i++) nested = { a: nested };
    expect(() => safeJson(nested)).toThrow(/nested too deeply/);
  });

  it('caps the number of nodes and string length', () => {
    expect(() => safeJson(new Array(LIMITS.nodes + 10).fill(0))).toThrow(/too large/);
    expect(() => safeJson('x'.repeat(LIMITS.string + 1))).toThrow(/over-long/);
  });

  it('strips control characters from text', () => {
    const doc = sampleDoc();
    doc.name = 'Desk\u0000\u0007 one';
    const r = parseWorkspaceValue(doc, NOW);
    expect(r.ok && r.workspace.meta.name).toBe('Desk one');
  });

  it('rejects unknown window kinds, chart types, bad instruments and module ids', () => {
    expect(() => validateWindow({ kind: 'evil' })).toThrow(/unknown window kind/);
    expect(() => validateWindow({ ...chartState('x', 'footprint'), template: 'nope' })).toThrow(/chart type/);
    expect(() => validateWindow({ ...chartState('x', 'footprint'), instrumentId: '<script>' })).toThrow(/instrument/);
    expect(() => validateWindow({ kind: 'module', module: '../../etc' })).toThrow(/module id/);
    expect(() => validateWindow({ kind: 'module', module: 42 })).toThrow(/module id/);
  });

  it('repairs out-of-range window fields with defaults', () => {
    const w = validateWindow({
      ...chartState('mock:ESZ6', 'footprint'),
      lots: -5,
      link: 'pink',
      heatColumnMs: 7,
      timeframe: { kind: 'time', ms: -1 },
      footprintMode: 'x'.repeat(200),
    });
    expect(w).toMatchObject({
      lots: 1,
      link: 'none',
      heatColumnMs: 250,
      timeframe: { kind: 'time', ms: 300_000 },
      footprintMode: 'volume',
    });
    const d = validateWindow({ ...domState('mock:ESZ6'), grouping: 1e9 });
    expect(d).toMatchObject({ grouping: 1 });
  });

  it('rejects too many layouts or windows and missing tabs', () => {
    const doc = sampleDoc();
    expect(parseWorkspaceFile(wrap({ ...doc, tabs: [] }))).toMatchObject({ ok: false });
    expect(
      parseWorkspaceFile(wrap({ ...doc, tabs: new Array(LIMITS.tabs + 1).fill(doc.tabs[0]) })),
    ).toMatchObject({ ok: false, error: 'The workspace has too many layouts' });
    const many = Object.fromEntries(
      Array.from({ length: LIMITS.windowsPerTab + 1 }, (_, i) => [`w${i}`, domState('mock:ESZ6')]),
    );
    expect(
      parseWorkspaceFile(wrap({ ...doc, tabs: [{ ...doc.tabs[0], layout: null, windows: many }] })),
    ).toMatchObject({ ok: false });
    expect(
      parseWorkspaceFile(wrap({ ...doc, tabs: [{ ...doc.tabs[0], windows: { 'bad id!': domState('x') } }] })),
    ).toMatchObject({ ok: false });
  });

  it('drops a layout that references unknown windows and rebuilds the tab from its windows', () => {
    const doc = sampleDoc();
    const tab = doc.tabs[0]!;
    const layout = layoutFor(['chart-1', 'ghost'], { 'chart-1': 'chart', ghost: 'chart' });
    const r = parseWorkspaceFile(wrap({ ...doc, tabs: [{ ...tab, layout }] }), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.workspace.doc.tabs[0]!;
    expect(t.layout).toBeNull();
    expect(t.specs?.map((s) => s.id)).toEqual(Object.keys(tab.windows));
    expect(r.warnings[0]).toMatch(/rebuilt/);
  });

  it('a layout panel must use the component of its window kind', () => {
    const doc = sampleDoc();
    const w = doc.tabs[0]!.windows;
    expect(validateLayout(layoutFor(['chart-1'], { 'chart-1': 'module' }), w)).toBeNull();
    expect(validateLayout(layoutFor(['chart-1'], { 'chart-1': 'chart' }), w)).not.toBeNull();
    expect(validateLayout({ grid: 'x', panels: {} }, w)).toBeNull();
  });

  it('fixes duplicate tab ids and an unknown active tab', () => {
    const doc = sampleDoc();
    const r = parseWorkspaceValue({ ...doc, activeTab: 'zzz', tabs: [doc.tabs[0], doc.tabs[0]] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.workspace.doc.tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.workspace.doc.activeTab).toBe(ids[0]);
  });

  it('ignores invalid display data instead of failing', () => {
    const r = parseWorkspaceValue({ ...sampleDoc(), display: { main: { x: 'a' } } }, NOW);
    expect(r.ok && r.workspace.doc.display).toBeUndefined();
  });
});

describe('helpers', () => {
  it('tiles windows without a layout', () => {
    const specs = specsFromWindows({ a: domState('x'), b: domState('x'), c: domState('x'), d: domState('x') });
    expect(specs.map((s) => s.position?.dir ?? null)).toEqual([null, 'right', 'below', 'right']);
  });
  it('makes Windows-safe file names', () => {
    expect(workspaceFileName('Scalping: NQ/ES?')).toBe('Scalping NQ ES.htworkspace');
    expect(workspaceFileName('...')).toBe('workspace.htworkspace');
  });
});
