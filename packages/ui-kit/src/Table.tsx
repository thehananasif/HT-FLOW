import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  nextSort,
  scrollIntoViewTop,
  selectRow,
  sortRows,
  virtualRange,
  type SelectionState,
  type SortState,
} from './tableLogic';

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  /** px width; omit for flexible. */
  width?: number;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Value used for sorting (default: `row[key]`). */
  sortValue?: (row: T) => unknown;
  render?: (row: T) => ReactNode;
  /** Use tabular numerals. */
  numeric?: boolean;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: readonly T[];
  rowId: (row: T) => string;
  rowHeight?: number;
  /** Fixed height in px; default fills the parent (min 120). */
  height?: number;
  sort?: SortState | null;
  onSortChange?: (s: SortState | null) => void;
  selectionMode?: 'none' | 'single' | 'multi';
  selected?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  onRowActivate?: (row: T) => void;
  empty?: ReactNode;
  className?: string;
  'aria-label': string;
}

/** Virtualized, sortable data table with fixed header, row selection and keyboard navigation. */
export function Table<T>({
  columns,
  rows,
  rowId,
  rowHeight = 22,
  height,
  sort: sortProp,
  onSortChange,
  selectionMode = 'none',
  selected: selectedProp,
  onSelectionChange,
  onRowActivate,
  empty,
  className,
  'aria-label': ariaLabel,
}: TableProps<T>) {
  const [sortLocal, setSortLocal] = useState<SortState | null>(null);
  const sort = sortProp === undefined ? sortLocal : sortProp;
  const [selLocal, setSelLocal] = useState<SelectionState>({ selected: new Set(), anchor: null });
  const selected = selectedProp ?? selLocal.selected;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(height ?? 240);
  const [cursor, setCursor] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);

  const colByKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const sorted = useMemo(
    () =>
      sortRows(rows, sort, (r, k) => {
        const c = colByKey.get(k);
        return c?.sortValue ? c.sortValue(r) : (r as Record<string, unknown>)[k];
      }),
    [rows, sort, colByKey],
  );
  const ids = useMemo(() => sorted.map(rowId), [sorted, rowId]);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || height || 240);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, sorted.length - 1))), [sorted.length]);

  const range = virtualRange(sorted.length, rowHeight, scrollTop, viewH);
  const template = columns.map((c) => (c.width ? `${c.width}px` : 'minmax(60px, 1fr)')).join(' ');

  const setSel = (next: SelectionState) => {
    anchor.current = next.anchor;
    setSelLocal(next);
    onSelectionChange?.(next.selected);
  };
  const pick = (i: number, mods: { shift?: boolean; ctrl?: boolean }) => {
    if (selectionMode === 'none') return;
    const id = ids[i];
    if (id === undefined) return;
    setSel(
      selectRow(ids, { selected: new Set(selected), anchor: anchor.current }, id, mods, selectionMode === 'multi'),
    );
  };
  const moveCursor = (i: number) => {
    const c = Math.max(0, Math.min(sorted.length - 1, i));
    setCursor(c);
    const el = body.current;
    if (el) {
      const top = scrollIntoViewTop(c, rowHeight, el.scrollTop, el.clientHeight);
      if (top !== el.scrollTop) el.scrollTop = top;
    }
    return c;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(viewH / rowHeight) - 1);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = cursor + 1;
    else if (e.key === 'ArrowUp') next = cursor - 1;
    else if (e.key === 'PageDown') next = cursor + page;
    else if (e.key === 'PageUp') next = cursor - page;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = sorted.length - 1;
    if (next != null) {
      e.preventDefault();
      const c = moveCursor(next);
      if (e.shiftKey) pick(c, { shift: true });
      else if (selectionMode === 'single') pick(c, {});
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      pick(cursor, { ctrl: selectionMode === 'multi' });
    } else if (e.key === 'Enter' && sorted[cursor]) {
      e.preventDefault();
      onRowActivate?.(sorted[cursor]!);
    } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && selectionMode === 'multi') {
      e.preventDefault();
      setSel({ selected: new Set(ids), anchor: ids[0] ?? null });
    }
  };

  const changeSort = (key: string) => {
    const next = nextSort(sort, key);
    setSortLocal(next);
    onSortChange?.(next);
  };

  const activeId = ids[cursor];
  return (
    <div
      className={`ht-table ${className ?? ''}`}
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={sorted.length + 1}
      aria-multiselectable={selectionMode === 'multi' || undefined}
      style={height ? { height } : undefined}
    >
      <div className="ht-table-head" role="row" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => {
          const dir = sort?.key === c.key ? sort.dir : null;
          return (
            <div
              key={c.key}
              role="columnheader"
              className="ht-table-th"
              data-align={c.align}
              aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
            >
              {c.sortable ? (
                <button type="button" className="ht-table-sort" onClick={() => changeSort(c.key)}>
                  <span>{c.header}</span>
                  {dir === 'asc' && <ArrowUp size={10} aria-hidden />}
                  {dir === 'desc' && <ArrowDown size={10} aria-hidden />}
                </button>
              ) : (
                <span>{c.header}</span>
              )}
            </div>
          );
        })}
      </div>
      <div
        ref={body}
        className="ht-table-body"
        tabIndex={0}
        role="rowgroup"
        aria-activedescendant={activeId !== undefined ? `ht-row-${activeId}` : undefined}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKey}
      >
        {sorted.length === 0 ? (
          <div className="ht-table-empty">{empty ?? 'No rows'}</div>
        ) : (
          <div style={{ height: range.totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${range.offsetTop}px)` }}>
              {sorted.slice(range.start, range.end).map((row, k) => {
                const i = range.start + k;
                const id = ids[i]!;
                const isSel = selected.has(id);
                return (
                  <div
                    key={id}
                    id={`ht-row-${id}`}
                    role="row"
                    aria-rowindex={i + 2}
                    aria-selected={selectionMode === 'none' ? undefined : isSel}
                    className="ht-table-row"
                    data-selected={isSel || undefined}
                    data-cursor={i === cursor || undefined}
                    style={{ gridTemplateColumns: template, height: rowHeight }}
                    onClick={(e) => {
                      setCursor(i);
                      pick(i, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
                    }}
                    onDoubleClick={() => onRowActivate?.(row)}
                  >
                    {columns.map((c) => (
                      <div
                        key={c.key}
                        role="gridcell"
                        className={c.numeric ? 'ht-table-td tnum' : 'ht-table-td'}
                        data-align={c.align ?? (c.numeric ? 'right' : undefined)}
                      >
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
