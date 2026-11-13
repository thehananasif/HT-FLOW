/** Pure helpers behind DataTable: sorting, filtering, grouping and CSV export. */

export type CellValue = string | number | null | undefined;

export interface TableView {
  hidden: string[];
  sort: { id: string; dir: 'asc' | 'desc' } | null;
  filters: Record<string, string>;
  groupBy: string | null;
}

export interface SavedView {
  name: string;
  view: TableView;
}

export const emptyView = (hidden: string[] = []): TableView => ({
  hidden,
  sort: null,
  filters: {},
  groupBy: null,
});

export function sanitizeView(raw: unknown, fallback: TableView): TableView {
  if (!raw || typeof raw !== 'object') return fallback;
  const v = raw as Partial<TableView>;
  return {
    hidden: Array.isArray(v.hidden) ? v.hidden.filter((x) => typeof x === 'string') : [],
    sort:
      v.sort && typeof v.sort.id === 'string' && (v.sort.dir === 'asc' || v.sort.dir === 'desc')
        ? { id: v.sort.id, dir: v.sort.dir }
        : null,
    filters: v.filters && typeof v.filters === 'object' ? { ...v.filters } : {},
    groupBy: typeof v.groupBy === 'string' ? v.groupBy : null,
  };
}

export function compareValues(a: CellValue, b: CellValue): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Per-column filter: plain text is a case-insensitive "contains"; `>`, `>=`, `<`, `<=`, `=` and
 * `!=` followed by a number compare numerically.
 */
export function matchesFilter(value: CellValue, filter: string): boolean {
  const f = filter.trim();
  if (!f) return true;
  const m = /^(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/.exec(f);
  if (m) {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    if (!Number.isFinite(n)) return false;
    const x = parseFloat(m[2]!);
    switch (m[1]) {
      case '>':
        return n > x;
      case '>=':
        return n >= x;
      case '<':
        return n < x;
      case '<=':
        return n <= x;
      case '=':
        return n === x;
      default:
        return n !== x;
    }
  }
  return String(value ?? '')
    .toLowerCase()
    .includes(f.toLowerCase());
}

export interface ValueColumn<T> {
  id: string;
  header: string;
  value(row: T): CellValue;
}

/** Applies the view's filters and sort (stable). */
export function applyView<T>(rows: readonly T[], cols: ValueColumn<T>[], view: TableView): T[] {
  const byId = new Map(cols.map((c) => [c.id, c]));
  const active = Object.entries(view.filters).filter(([id, f]) => f.trim() && byId.has(id));
  let out = active.length
    ? rows.filter((r) => active.every(([id, f]) => matchesFilter(byId.get(id)!.value(r), f)))
    : [...rows];
  const sc = view.sort && byId.get(view.sort.id);
  if (sc && view.sort) {
    const sign = view.sort.dir === 'asc' ? 1 : -1;
    out = out
      .map((r, i) => [r, i] as const)
      .sort((a, b) => sign * compareValues(sc.value(a[0]), sc.value(b[0])) || a[1] - b[1])
      .map((x) => x[0]);
  }
  return out;
}

export type FlatRow<T> =
  { kind: 'group'; key: string; count: number; collapsed: boolean } | { kind: 'row'; row: T };

/** Flattens rows into group headers + members (order of first appearance). */
export function groupRows<T>(
  rows: readonly T[],
  keyOf: ((row: T) => CellValue) | null,
  collapsed: ReadonlySet<string> = new Set(),
): FlatRow<T>[] {
  if (!keyOf) return rows.map((row) => ({ kind: 'row', row }));
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = String(keyOf(r) ?? '—');
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: FlatRow<T>[] = [];
  for (const [key, list] of groups) {
    const isCollapsed = collapsed.has(key);
    out.push({ kind: 'group', key, count: list.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const row of list) out.push({ kind: 'row', row });
  }
  return out;
}

const csvCell = (v: CellValue): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** RFC 4180 CSV (CRLF line ends, quotes doubled). */
export function toCsv<T>(rows: readonly T[], cols: ValueColumn<T>[]): string {
  const lines = [cols.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c.value(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function downloadText(name: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Header + data rows for the XLSX writer (numbers stay numeric). */
export function toSheetRows<T>(
  rows: readonly T[],
  cols: ValueColumn<T>[],
): { header: string[]; rows: CellValue[][] } {
  return {
    header: cols.map((c) => c.header),
    rows: rows.map((r) => cols.map((c) => c.value(r))),
  };
}

export function downloadBytes(name: string, data: Uint8Array, mime: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
