import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';
import { Button, Checkbox, IconButton } from '@htflow/ui-kit';
import { SymbolAnalytics } from '@htflow/analytics';
import type { WindowState } from '@htflow/workspace';
import { hub } from '../../state/market';
import { allInstruments } from '../../state/instruments';
import { isTauri } from '../../backend';
import { useWindows } from '../../state/windows';
import { chartTargetId } from '../smart-tape/shared';
import '../smart-tape/styles.css';
import './scanner.css';

import { translateLiteral as tl } from '@htflow/i18n';
/* ------------------------------------------------------------------ shared analytics engine */

const entries = new Map<string, { a: SymbolAnalytics; refs: number }>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  for (const e of entries.values()) e.a.update();
  for (const l of listeners) l();
}

/** One SymbolAnalytics per instrument shared by every scanner window (ref-counted). */
function acquire(id: string): void {
  const e = entries.get(id);
  if (e) {
    e.refs++;
    return;
  }
  const store = hub.retain(id);
  const a = new SymbolAnalytics(store, { budget: 300_000 });
  a.update();
  entries.set(id, { a, refs: 1 });
  timer ??= setInterval(tick, 1000);
}

function release(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  if (--e.refs > 0) return;
  entries.delete(id);
  hub.release(id);
  if (!entries.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Instruments a scanner may list: every instrument with a feed here (mock:* in the browser). */
export function scannerUniverse() {
  return allInstruments(isTauri).filter((i) => isTauri || !i.id.startsWith('binance-futures:'));
}

export const MAX_SYMBOLS = 200;

/** Validated instrument selection (persisted ids; default = whole universe). */
export function scannerIds(raw: unknown): string[] {
  const all = scannerUniverse().map((i) => i.id);
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => all.includes(x as string)) : all;
  return ids.slice(0, MAX_SYMBOLS);
}

/**
 * Retains analytics for `ids` (stores are created one per 120 ms so simulated history does not
 * block the UI) and re-renders once per second.
 */
export function useAnalytics(ids: string[]): SymbolAnalytics[] {
  const [, setV] = useState(0);
  const key = ids.join('|');
  useEffect(() => {
    const list = key ? key.split('|') : [];
    const held: string[] = [];
    let i = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const step = () => {
      if (i >= list.length) return;
      acquire(list[i]!);
      held.push(list[i]!);
      i++;
      setV((x) => x + 1);
      t = setTimeout(step, 120);
    };
    step();
    const l = () => setV((x) => x + 1);
    listeners.add(l);
    return () => {
      if (t) clearTimeout(t);
      listeners.delete(l);
      held.forEach(release);
    };
  }, [key]);
  return ids.flatMap((id) => {
    const e = entries.get(id);
    return e && e.a.store.ready ? [e.a] : [];
  });
}

/** Points the last active chart window (or the first chart) at an instrument. */
export function openOnChart(instrumentId: string, timeframeMs?: number): void {
  const target = chartTargetId();
  if (!target) return;
  const patch: Record<string, unknown> = { instrumentId };
  if (timeframeMs) patch.timeframe = { kind: 'time', ms: timeframeMs };
  useWindows.getState().patch(target, patch as Partial<WindowState>);
}

/* ------------------------------------------------------------------ table */

export interface ScanColumn<R> {
  id: string;
  label: string;
  /** Sort value; NaN / undefined sort last. */
  sort: (r: R) => number | string;
  cell: (r: R) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** CSS grid track, default 1fr. */
  width?: string;
}

export function ScannerTable<R extends { key: string }>({
  rows,
  columns,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
  rowProps,
  empty,
}: {
  rows: R[];
  columns: ScanColumn<R>[];
  sortKey: string;
  sortDir: 'asc' | 'desc';
  onSort: (key: string, dir: 'asc' | 'desc') => void;
  onRowClick?: (r: R) => void;
  rowProps?: (r: R) => Record<string, string | boolean | undefined>;
  empty: string;
}) {
  const col = columns.find((c) => c.id === sortKey) ?? columns[0]!;
  const s = sortDir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const x = col.sort(a);
    const y = col.sort(b);
    const bad = (v: number | string) => typeof v === 'number' && Number.isNaN(v);
    if (bad(x) || bad(y)) return bad(x) ? (bad(y) ? 0 : 1) : -1;
    if (typeof x === 'string' || typeof y === 'string')
      return String(x).localeCompare(String(y)) * s;
    return (x - y) * s;
  });
  const grid = columns.map((c) => c.width ?? '1fr').join(' ');
  return (
    <div className="scan-wrap tnum" data-testid="scanner-table">
      <div className="scan-head" style={{ gridTemplateColumns: grid }}>
        {columns.map((c) => (
          <button
            key={c.id}
            className="scan-c"
            data-align={c.align ?? 'right'}
            data-sorted={c.id === col.id ? sortDir : undefined}
            onClick={() =>
              onSort(c.id, c.id === col.id ? (sortDir === 'desc' ? 'asc' : 'desc') : 'desc')
            }
          >
            {tl(c.label)}
            {c.id === col.id ? (sortDir === 'desc' ? ' ▾' : ' ▴') : ''}
          </button>
        ))}
      </div>
      <div className="scan-body">
        {sorted.map((r) => (
          <div
            key={r.key}
            className="scan-row"
            data-testid="scanner-row"
            style={{ gridTemplateColumns: grid }}
            onClick={() => onRowClick?.(r)}
            {...(rowProps?.(r) ?? {})}
          >
            {columns.map((c) => (
              <span key={c.id} className="scan-c" data-align={c.align ?? 'right'}>
                {c.cell(r)}
              </span>
            ))}
          </div>
        ))}
        {!sorted.length && <div className="tbl-empty">{empty}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ frame + settings */

export function ScannerFrame({
  testId,
  subtitle,
  chips,
  settings,
  footer,
  children,
}: {
  testId: string;
  subtitle: ReactNode;
  chips?: ReactNode;
  settings: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="module-window scan-win" data-testid={testId}>
      <div className="an-toolbar">
        <span className="an-sub">{subtitle}</span>
        <span className="grow" />
        {chips}
        <div className="scan-pop-anchor" ref={ref}>
          <IconButton label={tl('Settings')} active={open} onClick={() => setOpen((x) => !x)}>
            <Settings2 size={13} />
          </IconButton>
          {open && <div className="scan-pop">{settings}</div>}
        </div>
      </div>
      {children}
      <div className="an-footer">{footer}</div>
    </div>
  );
}

/** Instrument list + alert toggle shared by every scanner's settings popover. */
export function CommonSettings({
  ids,
  alerts,
  onIds,
  onAlerts,
  onReset,
  children,
}: {
  ids: string[];
  alerts: boolean;
  onIds: (ids: string[]) => void;
  onAlerts: (v: boolean) => void;
  onReset: () => void;
  children?: ReactNode;
}) {
  const all = scannerUniverse();
  return (
    <>
      {children}
      <Checkbox
        checked={alerts}
        onChange={onAlerts}
        label={tl('Alert (toast + sound) on new signals')}
      />
      <div className="scan-pop-title">
        {tl('Instruments (')}
        {ids.length}/{Math.min(all.length, MAX_SYMBOLS)})
        <span className="grow" />
        <button className="link" onClick={() => onIds(all.map((i) => i.id))}>
          {tl('All')}
        </button>
        <button className="link" onClick={() => onIds([])}>
          {tl('None')}
        </button>
      </div>
      <div className="scan-pop-list">
        {all.map((i) => (
          <Checkbox
            key={i.id}
            checked={ids.includes(i.id)}
            label={`${i.symbol} · ${i.exchange}`}
            onChange={(v) =>
              onIds(
                v
                  ? all.map((x) => x.id).filter((x) => x === i.id || ids.includes(x))
                  : ids.filter((x) => x !== i.id),
              )
            }
          />
        ))}
      </div>
      <Button size="xs" onClick={onReset}>
        {tl('Reset to default')}
      </Button>
    </>
  );
}

/** Sort state persisted in params. */
export function sortParams(raw: Record<string, unknown> | undefined, def: string) {
  const r = raw ?? {};
  return {
    sortKey: typeof r.sortKey === 'string' ? r.sortKey : def,
    sortDir: r.sortDir === 'asc' ? ('asc' as const) : ('desc' as const),
  };
}

/** Background tint for a value graded by intensity 0..1. */
export const tint = (color: string, k: number) =>
  `color-mix(in srgb, ${color} ${Math.round(Math.min(1, Math.max(0, k)) * 100)}%, transparent)`;
