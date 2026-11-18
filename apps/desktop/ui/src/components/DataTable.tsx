import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, type MenuEntry } from '@htflow/ui-kit';
import {
  applyView,
  downloadBytes,
  downloadText,
  emptyView,
  groupRows,
  sanitizeView,
  toCsv,
  toSheetRows,
  type CellValue,
  type SavedView,
  type TableView,
} from './DataTable.utils';
import { buildXlsx, XLSX_MIME } from './xlsx';
import './DataTable.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
export type { SavedView, TableView } from './DataTable.utils';

export interface DataColumn<T> {
  id: string;
  header: string;
  /** Flex weight (default 1). */
  width?: number;
  align?: 'left' | 'right';
  /** Raw value used for sorting, filtering, grouping and export. */
  value(row: T): CellValue;
  /** Cell content; defaults to the value. */
  render?(row: T): ReactNode;
  mono?: boolean;
  /** Hidden until enabled in the column chooser. */
  defaultHidden?: boolean;
  /** Action columns: not sortable / filterable / exported. */
  action?: boolean;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: DataColumn<T>[];
  rowKey(row: T): string;
  title?: string;
  subtitle?: string;
  /** Buttons shown right of the title (before ☰). */
  actions?: ReactNode;
  footer?: ReactNode;
  empty?: string;
  rowHeight?: number;
  /** Controlled view; omit to keep it local to the component. */
  view?: TableView;
  onViewChange?(view: TableView): void;
  /** Saved views; persisted by the caller through onSavedViewsChange. */
  savedViews?: SavedView[];
  onSavedViewsChange?(views: SavedView[]): void;
  exportName?: string;
  onRowClick?(row: T): void;
  selectedKey?: string | null;
  testId?: string;
}

/**
 * Virtualised table (P20): only the visible rows are in the DOM. Column chooser (☰), click-to-sort
 * headers, per-column filters, optional grouping, saved views and CSV export.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { rows, columns, rowKey, rowHeight = 28 } = props;
  const defaults = useMemo(
    () => emptyView(columns.filter((c) => c.defaultHidden).map((c) => c.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns.map((c) => c.id).join('|')],
  );
  const [local, setLocal] = useState<TableView>(defaults);
  const view = props.view ?? local;
  const setView = (v: TableView) => (props.onViewChange ? props.onViewChange(v) : setLocal(v));
  const [showFilters, setShowFilters] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const dataCols = columns.filter((c) => !c.action);
  const visible = columns.filter((c) => !view.hidden.includes(c.id));
  const filtered = useMemo(() => applyView(rows, dataCols, view), [rows, dataCols, view]);
  const groupCol = dataCols.find((c) => c.id === view.groupBy) ?? null;
  const flat = useMemo(
    () => groupRows(filtered, groupCol ? groupCol.value : null, collapsed),
    [filtered, groupCol, collapsed],
  );
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4);
  const end = Math.min(flat.length, Math.ceil((scrollTop + height) / rowHeight) + 4);
  const hasFilters = Object.values(view.filters).some((f) => f.trim());

  const exportCsv = () =>
    downloadText(
      `${props.exportName ?? props.title ?? 'table'}.csv`.toLowerCase().replaceAll(' ', '-'),
      toCsv(
        filtered,
        dataCols.filter((c) => !view.hidden.includes(c.id)),
      ),
    );
  const exportXlsx = () => {
    const sheet = toSheetRows(
      filtered,
      dataCols.filter((c) => !view.hidden.includes(c.id)),
    );
    downloadBytes(
      `${props.exportName ?? props.title ?? 'table'}.xlsx`.toLowerCase().replaceAll(' ', '-'),
      buildXlsx(props.title ?? 'Table', sheet.header, sheet.rows),
      XLSX_MIME,
    );
  };
  const saved = props.savedViews ?? [];
  const menu: MenuEntry[] = [
    { kind: 'label', id: 'l-cols', label: 'Columns' },
    ...columns
      .filter((c) => c.header)
      .map<MenuEntry>((c) => ({
        id: `col-${c.id}`,
        label: c.header,
        checked: !view.hidden.includes(c.id),
        onSelect: () =>
          setView({
            ...view,
            hidden: view.hidden.includes(c.id)
              ? view.hidden.filter((x) => x !== c.id)
              : [...view.hidden, c.id],
          }),
      })),
    { kind: 'separator', id: 's1' },
    {
      kind: 'submenu',
      id: 'group',
      label: `Group by${groupCol ? `: ${groupCol.header}` : ''}`,
      items: [
        {
          id: 'g-none',
          label: 'None',
          checked: !groupCol,
          onSelect: () => setView({ ...view, groupBy: null }),
        },
        ...dataCols.map<MenuEntry>((c) => ({
          id: `g-${c.id}`,
          label: c.header,
          checked: view.groupBy === c.id,
          onSelect: () => setView({ ...view, groupBy: c.id }),
        })),
      ],
    },
    {
      id: 'filters',
      label: 'Column filters',
      checked: showFilters,
      onSelect: () => setShowFilters(!showFilters),
    },
    ...(props.onSavedViewsChange
      ? ([
          {
            kind: 'submenu',
            id: 'views',
            label: 'Saved views',
            items: [
              ...saved.map<MenuEntry>((s) => ({
                id: `v-${s.name}`,
                label: s.name,
                onSelect: () => setView(s.view),
              })),
              ...(saved.length ? [{ kind: 'separator', id: 'vs' } as MenuEntry] : []),
              {
                id: 'v-save',
                label: 'Save current view…',
                onSelect: () => {
                  const name = window.prompt('View name')?.trim();
                  if (name)
                    props.onSavedViewsChange!([
                      ...saved.filter((s) => s.name !== name),
                      { name, view },
                    ]);
                },
              },
              ...saved.map<MenuEntry>((s) => ({
                id: `vd-${s.name}`,
                label: `Delete "${s.name}"`,
                onSelect: () => props.onSavedViewsChange!(saved.filter((x) => x.name !== s.name)),
              })),
            ],
          },
        ] as MenuEntry[])
      : []),
    { kind: 'separator', id: 's2' },
    { id: 'csv', label: 'Export CSV', onSelect: exportCsv },
    { id: 'xlsx', label: 'Export XLSX', onSelect: exportXlsx },
    { id: 'reset', label: 'Reset view', onSelect: () => setView(defaults) },
  ];

  const cellStyle = (c: DataColumn<T>) => ({
    flex: `${c.width ?? 1} 1 0`,
    textAlign: c.align ?? ('left' as const),
  });

  return (
    <div className="dt" data-testid={props.testId}>
      <div className="dt-bar">
        {props.title && <b>{tl(props.title)}</b>}
        {props.subtitle && <span className="muted">· {props.subtitle}</span>}
        {hasFilters && <span className="dt-filtered">{tl('filtered')}</span>}
        <span className="grow" />
        {props.actions}
        <DropdownMenu
          align="end"
          items={menu}
          trigger={
            <button
              className="dt-menu"
              aria-label={tl('Columns')}
              title={tl('Columns, grouping, views')}
            >
              ☰
            </button>
          }
        />
      </div>
      <div className="dt-head" role="row">
        {visible.map((c) => {
          const sorted = view.sort?.id === c.id ? view.sort.dir : null;
          return (
            <span
              key={c.id}
              role="columnheader"
              style={cellStyle(c)}
              className={c.action ? undefined : 'dt-sortable'}
              aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
              onClick={() =>
                !c.action &&
                setView({
                  ...view,
                  sort:
                    sorted === 'desc'
                      ? { id: c.id, dir: 'asc' }
                      : sorted === 'asc'
                        ? null
                        : { id: c.id, dir: 'desc' },
                })
              }
            >
              {tl(c.header)} {sorted ? (sorted === 'asc' ? '▴' : '▾') : ''}
            </span>
          );
        })}
      </div>
      {showFilters && (
        <div className="dt-filters">
          {visible.map((c) => (
            <span key={c.id} style={cellStyle(c)}>
              {!c.action && (
                <input
                  aria-label={tt`Filter ${tl(c.header)}`}
                  placeholder={tl('filter')}
                  value={view.filters[c.id] ?? ''}
                  onChange={(e) =>
                    setView({ ...view, filters: { ...view.filters, [c.id]: e.target.value } })
                  }
                />
              )}
            </span>
          ))}
        </div>
      )}
      <div
        className="dt-scroll"
        ref={scroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: flat.length * rowHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
            {flat.slice(start, end).map((f) =>
              f.kind === 'group' ? (
                <div
                  key={`g:${f.key}`}
                  className="dt-group"
                  style={{ height: rowHeight }}
                  onClick={() => {
                    const n = new Set(collapsed);
                    if (n.has(f.key)) n.delete(f.key);
                    else n.add(f.key);
                    setCollapsed(n);
                  }}
                >
                  {f.collapsed ? '▸' : '▾'} {tl(groupCol?.header)}: {f.key}
                  <span className="muted"> · {f.count}</span>
                </div>
              ) : (
                <div
                  key={rowKey(f.row)}
                  role="row"
                  className="dt-row tnum"
                  style={{ height: rowHeight }}
                  aria-selected={props.selectedKey === rowKey(f.row) || undefined}
                  onClick={props.onRowClick ? () => props.onRowClick!(f.row) : undefined}
                >
                  {visible.map((c) => (
                    <span
                      key={c.id}
                      role="cell"
                      style={cellStyle(c)}
                      className={c.mono ? 'mono' : undefined}
                    >
                      {c.render ? c.render(f.row) : c.value(f.row)}
                    </span>
                  ))}
                </div>
              ),
            )}
          </div>
        </div>
        {!flat.length && <div className="tbl-empty">{props.empty ?? 'No rows'}</div>}
      </div>
      {props.footer && <div className="dt-foot">{props.footer}</div>}
    </div>
  );
}

/** Coloured pill used by table cells (side, status, event type). */
export function Pill({
  tone,
  children,
}: {
  tone: 'up' | 'down' | 'warning' | 'info' | 'muted';
  children: ReactNode;
}) {
  return <span className={`dt-pill dt-pill--${tone}`}>{children}</span>;
}

/**
 * Wires a DataTable's view and saved views to a module window's persisted params
 * (`state.params` / `setParams` from the module registry).
 */
export function tableParams<T>(
  params: Record<string, unknown> | undefined,
  setParams: (patch: Record<string, unknown>) => void,
  columns: DataColumn<T>[],
  key = 'table',
): Pick<DataTableProps<T>, 'view' | 'onViewChange' | 'savedViews' | 'onSavedViewsChange'> {
  const raw = params?.[key] as { view?: unknown; saved?: unknown } | undefined;
  const fallback = emptyView(columns.filter((c) => c.defaultHidden).map((c) => c.id));
  const saved = Array.isArray(raw?.saved)
    ? (raw.saved as SavedView[]).filter((s) => s && typeof s.name === 'string')
    : [];
  const view = sanitizeView(raw?.view, fallback);
  return {
    view,
    savedViews: saved,
    onViewChange: (v) => setParams({ [key]: { view: v, saved } }),
    onSavedViewsChange: (s) => setParams({ [key]: { view, saved: s } }),
  };
}
