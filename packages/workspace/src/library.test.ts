import { describe, expect, it } from 'vitest';
import {
  addWorkspace,
  deleteWorkspace,
  duplicateWorkspace,
  emptyLibrary,
  filterWorkspaces,
  MAX_RECENT,
  readLibrary,
  renameWorkspace,
  sortWorkspaces,
  toggleFavourite,
  uniqueName,
  updateWorkspaceDoc,
  validateName,
} from './library';
import { STARTER_WORKSPACES } from './starters';

const doc = () => STARTER_WORKSPACES[0]!.build();

describe('workspace library', () => {
  it('save as, rename, duplicate, favourite, delete', () => {
    let lib = emptyLibrary();
    const a = addWorkspace(lib, doc(), { name: 'Desk', description: 'd' }, 1);
    lib = a.lib;
    expect(lib.items[0]!.meta).toMatchObject({ name: 'Desk', description: 'd', createdAt: 1 });
    expect(lib.items[0]!.doc.name).toBe('Desk');
    expect(lib.recent).toEqual([a.id]);

    const b = addWorkspace(lib, doc(), { name: 'desk' }, 2);
    lib = b.lib;
    expect(lib.items[1]!.meta.name).toBe('desk (2)');

    lib = renameWorkspace(lib, a.id, 'Morning', 3);
    expect(lib.items[0]!.meta).toMatchObject({ name: 'Morning', updatedAt: 3 });
    expect(lib.items[0]!.doc.name).toBe('Morning');
    expect(() => renameWorkspace(lib, b.id, 'morning')).toThrow(/already exists/);
    expect(() => renameWorkspace(lib, b.id, '  ')).toThrow(/Enter a name/);

    const c = duplicateWorkspace(lib, a.id, 4);
    lib = c.lib;
    expect(lib.items[2]!.meta.name).toBe('Morning copy');
    expect(lib.items[2]!.doc).not.toBe(lib.items[0]!.doc);
    expect(lib.items[2]!.doc.tabs).toEqual(lib.items[0]!.doc.tabs);

    lib = toggleFavourite(lib, c.id);
    expect(lib.items[2]!.meta.favourite).toBe(true);

    lib = { ...lib, currentId: c.id };
    lib = deleteWorkspace(lib, c.id);
    expect(lib.items).toHaveLength(2);
    expect(lib.recent).not.toContain(c.id);
    expect(lib.currentId).toBeNull();
  });

  it('save current overwrites the document but keeps the name', () => {
    const { lib, id } = addWorkspace(emptyLibrary(), doc(), { name: 'Keep' }, 1);
    const d = { ...doc(), name: 'Other', tabs: doc().tabs.slice(0, 1) };
    const next = updateWorkspaceDoc(lib, id, d, 9);
    expect(next.items[0]!.doc.name).toBe('Keep');
    expect(next.items[0]!.meta.updatedAt).toBe(9);
    expect(next.items[0]!.doc.savedAt).toBe(9);
  });

  it('keeps a bounded recent list', () => {
    let lib = emptyLibrary();
    for (let i = 0; i < MAX_RECENT + 3; i++)
      lib = addWorkspace(lib, doc(), { name: `W${i}` }, i).lib;
    expect(lib.recent).toHaveLength(MAX_RECENT);
    expect(lib.items.find((w) => w.meta.id === lib.recent[0])!.meta.name).toBe(
      `W${MAX_RECENT + 2}`,
    );
  });

  it('unique names and validation', () => {
    expect(uniqueName('A', ['a', 'A (2)'])).toBe('A (3)');
    expect(uniqueName('A (2)', ['A', 'A (2)'])).toBe('A (3)');
    expect(uniqueName('', [])).toBe('Workspace');
    const { lib, id } = addWorkspace(emptyLibrary(), doc(), { name: 'X' });
    expect(validateName(lib, 'x')).toMatch(/exists/);
    expect(validateName(lib, 'x', id)).toBeNull();
    expect(validateName(lib, 'y'.repeat(200))).toMatch(/At most/);
  });

  it('sorts and filters', () => {
    let lib = emptyLibrary();
    lib = addWorkspace(lib, doc(), { name: 'b', description: 'futures' }, 1).lib;
    lib = addWorkspace(lib, doc(), { name: 'a', favourite: true }, 2).lib;
    lib = addWorkspace(lib, doc(), { name: 'c' }, 3).lib;
    expect(sortWorkspaces(lib.items, 'name').map((w) => w.meta.name)).toEqual(['a', 'b', 'c']);
    expect(sortWorkspaces(lib.items, 'created').map((w) => w.meta.name)).toEqual(['c', 'a', 'b']);
    expect(sortWorkspaces(lib.items, 'favourites')[0]!.meta.name).toBe('a');
    expect(filterWorkspaces(lib.items, 'FUT').map((w) => w.meta.name)).toEqual(['b']);
  });

  it('reads a stored library and drops invalid entries', () => {
    const { lib, id } = addWorkspace(emptyLibrary(), doc(), { name: 'Good' }, 1);
    const stored = JSON.parse(
      JSON.stringify({
        ...lib,
        currentId: id,
        recent: [id, 'gone'],
        items: [...lib.items, { meta: { name: 'Bad' }, doc: { tabs: 'nope' } }],
      }),
    );
    const back = readLibrary(stored);
    expect(back.items.map((w) => w.meta.name)).toEqual(['Good']);
    expect(back.recent).toEqual([id]);
    expect(back.currentId).toBe(id);
    expect(readLibrary('garbage')).toEqual(emptyLibrary());
    expect(readLibrary(null).items).toEqual([]);
  });
});
