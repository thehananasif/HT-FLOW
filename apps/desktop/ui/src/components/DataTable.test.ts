import { describe, expect, it } from 'vitest';
import {
  applyView,
  compareValues,
  emptyView,
  groupRows,
  matchesFilter,
  sanitizeView,
  toCsv,
  type ValueColumn,
} from './DataTable.utils';
import { pruneActivity, type ActivityEvent } from '../modules/activity/prune';

interface Row {
  sym: string;
  qty: number;
  note: string | null;
}
const rows: Row[] = [
  { sym: 'NQ', qty: 2, note: 'a,b' },
  { sym: 'ES', qty: 10, note: null },
  { sym: 'NQ', qty: 1, note: 'say "hi"' },
  { sym: 'CL', qty: 5, note: 'x' },
];
const cols: ValueColumn<Row>[] = [
  { id: 'sym', header: 'Symbol', value: (r) => r.sym },
  { id: 'qty', header: 'Qty', value: (r) => r.qty },
  { id: 'note', header: 'Note', value: (r) => r.note },
];

describe('DataTable helpers', () => {
  it('sorts numbers numerically, strings naturally, empties last', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues('a2', 'a10')).toBeLessThan(0);
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    const v = { ...emptyView(), sort: { id: 'qty', dir: 'desc' as const } };
    expect(applyView(rows, cols, v).map((r) => r.qty)).toEqual([10, 5, 2, 1]);
    const s = { ...emptyView(), sort: { id: 'sym', dir: 'asc' as const } };
    // Stable: the two NQ rows keep their original order.
    expect(applyView(rows, cols, s).map((r) => `${r.sym}${r.qty}`)).toEqual([
      'CL5',
      'ES10',
      'NQ2',
      'NQ1',
    ]);
  });

  it('filters by text and numeric operators', () => {
    expect(matchesFilter('BTCUSDT', 'btc')).toBe(true);
    expect(matchesFilter(5, '>= 5')).toBe(true);
    expect(matchesFilter(5, '<5')).toBe(false);
    expect(matchesFilter('abc', '>1')).toBe(false);
    const v = { ...emptyView(), filters: { sym: 'nq', qty: '>1', gone: 'x' } };
    expect(applyView(rows, cols, v)).toEqual([rows[0]]);
  });

  it('groups with collapsible headers', () => {
    const flat = groupRows(rows, (r) => r.sym, new Set(['ES']));
    expect(flat.map((f) => (f.kind === 'group' ? `${f.key}:${f.count}` : f.row.qty))).toEqual([
      'NQ:2',
      2,
      1,
      'ES:1',
      'CL:1',
      5,
    ]);
    expect(groupRows(rows, null)).toHaveLength(4);
  });

  it('exports RFC 4180 CSV', () => {
    expect(toCsv(rows.slice(0, 3), cols)).toBe(
      'Symbol,Qty,Note\r\nNQ,2,"a,b"\r\nES,10,\r\nNQ,1,"say ""hi"""\r\n',
    );
  });

  it('sanitizes persisted views', () => {
    const fb = emptyView(['x']);
    expect(sanitizeView(null, fb)).toBe(fb);
    expect(
      sanitizeView({ hidden: ['a', 3], sort: { id: 'q', dir: 'up' }, groupBy: 'sym' }, fb),
    ).toEqual({ hidden: ['a'], sort: null, filters: {}, groupBy: 'sym' });
  });
});

describe('Trading Activity retention', () => {
  it('keeps 90 days and a rolling cap', () => {
    const now = 1_000 * 86_400_000;
    const ev = (ts: number, id: string): ActivityEvent => ({
      id,
      ts,
      type: 'fill',
      account: 'A',
      message: '',
    });
    const list = [
      ev(now - 91 * 86_400_000, 'old'),
      ev(now - 89 * 86_400_000, 'a'),
      ev(now - 1000, 'b'),
      ev(now, 'c'),
    ];
    expect(pruneActivity(list, now).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(pruneActivity(list, now, 2).map((e) => e.id)).toEqual(['b', 'c']);
  });
});

describe('CSV formula injection', () => {
  it('prefixes formula-like text but keeps numbers', () => {
    const cols = [{ id: 'a', header: 'A', value: (r: { a: string | number }) => r.a }];
    const csv = toCsv(
      [
        { a: '=HYPERLINK("http://evil","x")' },
        { a: '+cmd|" /C calc"!A0' },
        { a: '-2+3+cmd' },
        { a: '@SUM(A1)' },
        { a: '\tx' },
        { a: '-12.5' },
        { a: -7 },
        { a: 'plain' },
      ],
      cols,
    ).split('\r\n');
    expect(csv.slice(1, 9)).toEqual([
      `"'=HYPERLINK(""http://evil"",""x"")"`,
      `"'+cmd|"" /C calc""!A0"`,
      `'-2+3+cmd`,
      `'@SUM(A1)`,
      `'\tx`,
      '-12.5',
      '-7',
      'plain',
    ]);
  });
});
