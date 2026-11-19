import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  COLUMN_IDS,
  duplicateTemplate,
  moveColumn,
  parseTemplates,
  resizeColumn,
  sanitizeTemplate,
  serializeTemplates,
  setColumnColors,
  toggleColumn,
} from './templates';

const SPEC_NAMES = [
  'Basic Extended',
  'Basic',
  'Compact',
  'Crypto DOM',
  'Dark (with notes)',
  'Dark Extended',
  'Dark',
  'Gray',
  'Light Bid-Ask',
  'Light Extended',
  'Light',
  'Limit Tracking',
  'Prop DOM',
];

describe('built-in templates', () => {
  it('are the 13 templates of the spec, in menu order, each a complete valid template', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).toEqual(SPEC_NAMES);
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.columns.map((c) => c.id).sort()).toEqual([...COLUMN_IDS].sort());
      expect(t.columns.some((c) => c.visible)).toBe(true);
      // Sanitizing a valid template is the identity.
      expect(sanitizeTemplate(t)).toEqual(t);
    }
    expect(BUILTIN_TEMPLATES.find((t) => t.id === 'prop')!.behaviour.showRiskLimits).toBe(true);
    expect(
      BUILTIN_TEMPLATES.find((t) => t.id === 'dark-notes')!.columns.find((c) => c.id === 'notes')!
        .visible,
    ).toBe(true);
  });
});

describe('template serialization', () => {
  it('round-trips through export / import as custom templates with new ids', () => {
    let n = 0;
    const src = setColumnColors(resizeColumn(BUILTIN_TEMPLATES[5]!, 'bid', 120), 'bid', {
      bg: '#101010',
      accent: '#00FF00',
    });
    const json = serializeTemplates([src]);
    const [back] = parseTemplates(json, () => `custom-${++n}`);
    expect(back!.id).toBe('custom-1');
    expect(back!.builtin).toBe(false);
    expect({ ...back!, id: src.id, builtin: true }).toEqual(src);
    expect(back!.columns.find((c) => c.id === 'bid')).toMatchObject({
      width: 120,
      bg: '#101010',
      accent: '#00FF00',
    });
  });

  it('accepts a bare template or array and rejects junk', () => {
    const id = () => 'x';
    expect(parseTemplates(JSON.stringify(BUILTIN_TEMPLATES[1]), id)).toHaveLength(1);
    expect(parseTemplates(JSON.stringify(BUILTIN_TEMPLATES.slice(0, 3)), id)).toHaveLength(3);
    expect(() => parseTemplates('{nope', id)).toThrow('Not valid JSON');
    expect(() => parseTemplates('[]', id)).toThrow('No templates');
  });

  it('sanitizes hostile or partial input', () => {
    const t = sanitizeTemplate({
      id: '../evil',
      name: '  ',
      columns: [
        { id: 'price', width: 9999, bg: 'red', fg: '#ABCDEF' },
        { id: 'bogus', width: 10 },
        { id: 'price', width: 10 },
      ],
      style: { fontSize: 99, rowHeight: -3, centring: 'sideways', palette: { bg: 'javascript:' } },
      behaviour: { volumeScope: 'range', pulledThreshold: -5, lotPresets: [0, 2, 'x', 5] },
    });
    expect(t.id).toBe('custom');
    expect(t.name).toBe('Basic Extended');
    expect(t.columns).toHaveLength(COLUMN_IDS.length);
    expect(t.columns[0]).toEqual({ id: 'price', visible: true, width: 400, fg: '#ABCDEF' });
    expect(t.columns.filter((c) => c.visible).map((c) => c.id)).toEqual(['price']);
    expect(t.style.fontSize).toBe(20);
    expect(t.style.rowHeight).toBe(12);
    expect(t.style.centring).toBe('view');
    expect(t.style.palette.bg).toBe(BUILTIN_TEMPLATES[0]!.style.palette.bg);
    expect(t.behaviour.volumeScope).toBe('range');
    expect(t.behaviour.pulledThreshold).toBe(0);
    expect(t.behaviour.lotPresets).toEqual([2, 5]);
    expect(sanitizeTemplate(null).columns.some((c) => c.visible)).toBe(true);
  });
});

describe('template edits', () => {
  const base = BUILTIN_TEMPLATES[1]!; // Basic: orders, bid, price, ask
  const vis = (t: typeof base) => t.columns.filter((c) => c.visible).map((c) => c.id);

  it('toggles, reorders and resizes columns', () => {
    let t = toggleColumn(base, 'notes');
    expect(vis(t)).toContain('notes');
    t = moveColumn(t, 'notes', 'orders');
    expect(vis(t)[0]).toBe('notes');
    t = moveColumn(t, 'orders', null);
    expect(t.columns.at(-1)!.id).toBe('orders');
    t = resizeColumn(t, 'price', 5);
    expect(t.columns.find((c) => c.id === 'price')!.width).toBe(24);
    // Never hides the last visible column.
    let only = base;
    for (const id of ['orders', 'bid', 'ask'] as const) only = toggleColumn(only, id, false);
    expect(vis(toggleColumn(only, 'price', false))).toEqual(['price']);
  });

  it('duplicates with a unique name and clears per-column colours on request', () => {
    const d = duplicateTemplate(base, 'c1', ['Basic copy']);
    expect(d).toMatchObject({ id: 'c1', builtin: false, name: 'Basic copy 2' });
    const coloured = setColumnColors(d, 'bid', { bg: '#111111' });
    expect(coloured.columns.find((c) => c.id === 'bid')!.bg).toBe('#111111');
    const cleared = setColumnColors(coloured, 'bid', { bg: undefined });
    expect(cleared.columns.find((c) => c.id === 'bid')!.bg).toBeUndefined();
  });
});
