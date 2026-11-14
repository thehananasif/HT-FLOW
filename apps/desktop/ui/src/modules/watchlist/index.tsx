import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, Plus, Star } from 'lucide-react';
import { ContextMenu, DropdownMenu, MenuTrigger, toast, type MenuEntry } from '@htflow/ui-kit';
import { formatCompact, type MarketStore } from '@htflow/market-data';
import { LINK_COLORS, type LinkColor, type WindowState } from '@htflow/workspace';
import { hub } from '../../state/market';
import { useWindows } from '../../state/windows';
import { isTauri } from '../../backend';
import { useCatalogVersion } from '../../state/discovery';
import { runCommand } from '../../shell/commands';
import {
  loadPickerPrefs,
  pickerEntries,
  pickerEntryFor,
  usePickerPrefs,
  type PickerEntry,
} from '../../state/instruments';
import { FeedStatusBadge, InstrumentPickerButton } from '../../components/InstrumentPicker';
import { isModuleBuilt, registerModule, type ModuleViewProps } from '../registry';
import { formatOiFunding, moveItem, RowStats, sparkPoints, statsFrom } from './stats';
import './styles.css';

// ------------------------------------------------------------------ params

type ColId =
  | 'last'
  | 'chg'
  | 'chgPct'
  | 'bid'
  | 'ask'
  | 'high'
  | 'low'
  | 'volume'
  | 'vwap'
  | 'delta'
  | 'oi'
  | 'spark';

const COLUMNS: { id: ColId; label: string }[] = [
  { id: 'last', label: 'Last' },
  { id: 'chg', label: 'Chg' },
  { id: 'chgPct', label: 'Chg %' },
  { id: 'bid', label: 'Bid' },
  { id: 'ask', label: 'Ask' },
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
  { id: 'volume', label: 'Volume' },
  { id: 'vwap', label: 'VWAP' },
  { id: 'delta', label: 'Delta' },
  { id: 'oi', label: 'OI / Funding' },
  { id: 'spark', label: 'Day' },
];
const DEFAULT_COLUMNS: ColId[] = ['last', 'chgPct', 'volume', 'delta', 'oi', 'spark'];

interface WlList {
  id: string;
  name: string;
  /** Catalog ids (cat:*) or feed ids. */
  symbols: string[];
}

interface WlParams {
  lists: WlList[];
  active: string;
  columns: ColId[];
  link: LinkColor;
  sort: { col: ColId | 'symbol'; dir: 1 | -1 } | null;
}

const BINANCE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];

function defaultLists(): WlList[] {
  return [
    { id: 'crypto', name: 'Crypto', symbols: BINANCE.map((s) => `cat:BINANCE-FUTURES:${s}`) },
    {
      id: 'futures',
      name: 'Futures',
      symbols: [
        'cat:NYMEX:CL',
        'cat:COMEX:GC',
        'cat:CME:ES',
        'cat:CME:NQ',
        'cat:NYMEX:NG',
        'cat:CBOT:ZN',
      ],
    },
    {
      id: 'stocks',
      name: 'Stocks',
      symbols: ['cat:NASDAQ:AAPL', 'cat:NASDAQ:MSFT', 'cat:NASDAQ:NVDA', 'cat:NASDAQ:TSLA'],
    },
  ];
}

/** Validates persisted params (every setting has a default). */
export function readParams(p: Record<string, unknown> | undefined): WlParams {
  const o = p ?? {};
  const lists = Array.isArray(o.lists)
    ? (o.lists as WlList[]).filter(
        (l) =>
          l && typeof l.id === 'string' && typeof l.name === 'string' && Array.isArray(l.symbols),
      )
    : [];
  const ls = lists.length ? lists : defaultLists();
  const cols = Array.isArray(o.columns)
    ? (o.columns as ColId[]).filter((c) => COLUMNS.some((x) => x.id === c))
    : DEFAULT_COLUMNS;
  const link = typeof o.link === 'string' && o.link in LINK_COLORS ? (o.link as LinkColor) : 'none';
  const sort = o.sort && typeof o.sort === 'object' ? (o.sort as WlParams['sort']) : null;
  return {
    lists: ls,
    active: ls.some((l) => l.id === o.active) ? (o.active as string) : ls[0]!.id,
    columns: cols,
    link,
    sort,
  };
}

// ------------------------------------------------------------------ live data

const statsByStore = new WeakMap<MarketStore, RowStats>();

/** Shared incremental stats per store (several watchlists reuse one). */
function statsFor(store: MarketStore): RowStats | null {
  let s = statsByStore.get(store);
  if (s) return s;
  if (!store.ready) return null;
  s = new RowStats(statsFrom(store.trades[0]?.ts, store.lastTs || Date.now()));
  s.add(store.trades);
  const stats = s;
  store.onTrades((t) => stats.add(t));
  statsByStore.set(store, s);
  return s;
}

function useTicker(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const i = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(i);
  }, [ms]);
}

/** Retains the feed only while the row is on screen (hub.retain / hub.release). */
function useVisibleFeed(el: React.RefObject<HTMLElement | null>, feedId: string | null) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)));
    io.observe(node);
    return () => io.disconnect();
  }, [el]);
  useEffect(() => {
    if (!visible || !feedId) return;
    hub.retain(feedId);
    return () => hub.release(feedId);
  }, [visible, feedId]);
  return visible && feedId ? (hub.peek(feedId) ?? null) : null;
}

// ------------------------------------------------------------------ actions

/** Runs a Dashboard open-command, then points the window it created at `feedId`. */
function openWith(command: string, feedId: string) {
  const before = new Set(Object.keys(useWindows.getState().windows));
  runCommand(command);
  const { windows, patch } = useWindows.getState();
  for (const [k, w] of Object.entries(windows)) {
    if (before.has(k)) continue;
    if (w.kind !== 'module') patch(k, { instrumentId: feedId } as Partial<WindowState>);
    else
      patch(k, { params: { ...(w.params ?? {}), instrumentId: feedId } } as Partial<WindowState>);
  }
}

/** Link group: drive every window of that colour to the selected instrument. */
function driveLinked(link: LinkColor, feedId: string) {
  if (link === 'none') return;
  const { windows, patch } = useWindows.getState();
  const target = Object.entries(windows).find(([, w]) => w.kind !== 'module' && w.link === link);
  if (target) patch(target[0], { instrumentId: feedId } as Partial<WindowState>);
}

// ------------------------------------------------------------------ view

const fmtPx = (ticks: number, tick: number, prec: number) =>
  Number.isFinite(ticks) ? (ticks * tick).toFixed(prec) : '—';
const fmtSigned = (v: number, digits = 2) =>
  Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(digits)}` : '—';
const dirClass = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

interface RowProps {
  id: string;
  index: number;
  entry: PickerEntry | undefined;
  columns: ColId[];
  selected: boolean;
  draggable: boolean;
  onSelect(): void;
  onRemove(): void;
  onDrop(from: number, to: number): void;
  onValues(id: string, v: Record<string, number>): void;
}

function Row({
  id,
  index,
  entry,
  columns,
  selected,
  draggable,
  onSelect,
  onRemove,
  onDrop,
  onValues,
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const feedId = entry?.feeds[0]?.id ?? null;
  const store = useVisibleFeed(ref, feedId);
  const stats = store ? statsFor(store) : null;
  const inst = store?.instrument;
  const tick = inst?.tickSize ?? entry?.tickSize ?? 1;
  const prec = inst?.pricePrecision ?? entry?.catalog?.pricePrecision ?? 2;
  const prevLast = useRef(Number.NaN);
  const flash = useRef<{ dir: 'up' | 'down'; n: number } | null>(null);
  const last = stats?.last ?? Number.NaN;
  if (Number.isFinite(last) && Number.isFinite(prevLast.current) && last !== prevLast.current)
    flash.current = {
      dir: last > prevLast.current ? 'up' : 'down',
      n: (flash.current?.n ?? 0) + 1,
    };
  prevLast.current = last;
  const fav = usePickerPrefs((s) => s.favourites.includes(entry?.key ?? id));
  const toggleFav = usePickerPrefs((s) => s.toggleFavourite);

  const values: Record<ColId, number> = {
    last,
    chg: stats ? stats.change * tick : Number.NaN,
    chgPct: stats?.changePct ?? Number.NaN,
    bid: store?.book.bestBid ?? Number.NaN,
    ask: store?.book.bestAsk ?? Number.NaN,
    high: stats && Number.isFinite(stats.high) ? stats.high : Number.NaN,
    low: stats && Number.isFinite(stats.low) ? stats.low : Number.NaN,
    volume: stats?.volume ?? Number.NaN,
    vwap: stats?.vwap ?? Number.NaN,
    delta: stats?.delta ?? Number.NaN,
    oi: store?.openInterest?.oi ?? Number.NaN,
    spark: stats?.changePct ?? Number.NaN,
  };
  useEffect(() => {
    onValues(id, values);
  });

  const cell = (c: ColId) => {
    const v = values[c];
    switch (c) {
      case 'last':
        return (
          <span
            key={`${c}-${flash.current?.n ?? 0}`}
            className="r tnum wl-last"
            data-flash={flash.current?.dir}
          >
            {feedId ? fmtPx(v, tick, prec) : 'No feed'}
          </span>
        );
      case 'bid':
      case 'ask':
      case 'high':
      case 'low':
      case 'vwap':
        return (
          <span key={c} className="r tnum">
            {fmtPx(v, tick, prec)}
          </span>
        );
      case 'chg':
        return (
          <span key={c} className={`r tnum ${dirClass(v)}`}>
            {fmtSigned(v, prec)}
          </span>
        );
      case 'chgPct':
        return (
          <span key={c} className={`r tnum ${dirClass(v)}`}>
            {Number.isFinite(v) ? `${fmtSigned(v)}%` : '—'}
          </span>
        );
      case 'volume':
        return (
          <span key={c} className="r tnum">
            {Number.isFinite(v) ? formatCompact(v) : '—'}
          </span>
        );
      case 'delta':
        return (
          <span key={c} className={`r tnum ${dirClass(v)}`}>
            {Number.isFinite(v) ? `${v > 0 ? '+' : ''}${formatCompact(v)}` : '—'}
          </span>
        );
      case 'oi': {
        // Fed by the crypto connectors' funding / open-interest streams; "—" when absent.
        const f = formatOiFunding(store, formatCompact);
        return (
          <span key={c} className={`r tnum${f.text === '—' ? ' muted' : ''}`} title={f.title}>
            {f.text}
          </span>
        );
      }
      case 'spark': {
        const pts = stats ? sparkPoints(stats.spark(), 64, 16) : '';
        return (
          <span key={c} className="wl-spark">
            {pts && (
              <svg width="64" height="16" aria-hidden="true">
                <polyline
                  points={pts}
                  fill="none"
                  strokeWidth="1.2"
                  stroke={stats!.changePct >= 0 ? 'var(--ht-up)' : 'var(--ht-down)'}
                />
              </svg>
            )}
          </span>
        );
      }
    }
  };

  const menu: MenuEntry[] = feedId
    ? [
        {
          kind: 'label',
          id: 'l',
          label: `${entry?.symbol ?? id} · ${entry?.feeds[0]?.label ?? ''}`,
        },
        { id: 'chart', label: 'Open Chart', onSelect: () => openWith('chart.footprint', feedId) },
        { id: 'dom', label: 'Open DOM', onSelect: () => openWith('open.smart-dom', feedId) },
        { id: 'heat', label: 'Open Heatmap', onSelect: () => openWith('open.heatmap', feedId) },
        {
          id: 'tape',
          label: 'Open Tape',
          disabled: !isModuleBuilt('smart-tape'),
          onSelect: () => openWith('open.smart-tape', feedId),
        },
        { kind: 'separator', id: 's' },
        { id: 'rm', label: 'Remove from list', onSelect: onRemove },
      ]
    : [
        { kind: 'label', id: 'l', label: `${entry?.symbol ?? id} · no feed` },
        {
          id: 'conn',
          label:
            isTauri || !entry?.desktopOnly ? 'Connect a feed…' : 'Available in the desktop app',
          disabled: !!entry?.desktopOnly && !isTauri,
          onSelect: () => runCommand('open.connections'),
        },
        { kind: 'separator', id: 's' },
        { id: 'rm', label: 'Remove from list', onSelect: onRemove },
      ];

  return (
    <ContextMenu items={menu}>
      <div
        ref={ref}
        className="wl-row"
        role="row"
        aria-selected={selected}
        data-testid={`wl-row-${entry?.symbol ?? id}`}
        draggable={draggable}
        onClick={onSelect}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/x-wl-index', String(index));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (draggable && e.dataTransfer.types.includes('text/x-wl-index')) e.preventDefault();
        }}
        onDrop={(e) => {
          const from = Number(e.dataTransfer.getData('text/x-wl-index'));
          if (Number.isFinite(from)) onDrop(from, index);
        }}
      >
        <span className="wl-sym">
          <button
            type="button"
            className="wl-star"
            aria-label={fav ? 'Unfavourite' : 'Favourite'}
            aria-pressed={fav}
            onClick={(e) => {
              e.stopPropagation();
              toggleFav(entry?.key ?? id);
            }}
          >
            <Star size={11} fill={fav ? 'currentColor' : 'none'} />
          </button>
          <span className="mono">{entry?.symbol ?? id}</span>
          {entry && entry.status !== 'live' && <FeedStatusBadge entry={entry} />}
        </span>
        {columns.map(cell)}
      </div>
    </ContextMenu>
  );
}

function Watchlist({ state, setParams }: ModuleViewProps) {
  useTicker(250);
  useEffect(loadPickerPrefs, []);
  const p = readParams(state.params);
  const list = p.lists.find((l) => l.id === p.active)!;
  const catVersion = useCatalogVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when live discovery merges symbols
  const entries = useMemo(() => pickerEntries(isTauri), [catVersion]);
  const [selected, setSelected] = useState<string | null>(null);
  const values = useRef(new Map<string, Record<string, number>>());

  const save = (patch: Partial<WlParams>) => setParams({ ...p, ...patch });
  const setList = (symbols: string[]) =>
    save({ lists: p.lists.map((l) => (l.id === list.id ? { ...l, symbols } : l)) });

  let ids = list.symbols;
  if (p.sort) {
    const { col, dir } = p.sort;
    const key = (id: string) =>
      col === 'symbol'
        ? (pickerEntryFor(id, entries)?.symbol ?? id)
        : (values.current.get(id)?.[col] ?? Number.NaN);
    ids = [...ids].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (typeof x === 'string' || typeof y === 'string')
        return String(x).localeCompare(String(y)) * dir;
      if (Number.isNaN(x)) return 1;
      if (Number.isNaN(y)) return -1;
      return (x - y) * dir;
    });
  }

  const sortBy = (col: ColId | 'symbol') =>
    save({
      sort: p.sort?.col !== col ? { col, dir: -1 } : p.sort.dir === -1 ? { col, dir: 1 } : null,
    });
  const arrow = (col: ColId | 'symbol') =>
    p.sort?.col === col ? (p.sort.dir === 1 ? ' ▲' : ' ▼') : '';

  const addList = () => {
    const name = window.prompt('List name', `List ${p.lists.length + 1}`)?.trim();
    if (!name) return;
    const id = `l${Date.now().toString(36)}`;
    save({ lists: [...p.lists, { id, name, symbols: [] }], active: id });
  };

  const gridCols = `minmax(140px, 1.4fr) ${p.columns.map((c) => (c === 'spark' ? '70px' : 'minmax(64px, 1fr)')).join(' ')}`;

  return (
    <div
      className="module-window wl"
      data-testid="watchlist"
      style={{ ['--wl-cols' as string]: gridCols }}
    >
      <div className="wl-top">
        <div className="wl-tabs" role="tablist" aria-label="Watchlists">
          {p.lists.map((l) => (
            <ContextMenu
              key={l.id}
              items={[
                {
                  id: 'rename',
                  label: 'Rename…',
                  onSelect: () => {
                    const n = window.prompt('List name', l.name)?.trim();
                    if (n)
                      save({ lists: p.lists.map((x) => (x.id === l.id ? { ...x, name: n } : x)) });
                  },
                },
                {
                  id: 'del',
                  label: 'Delete list',
                  disabled: p.lists.length < 2,
                  onSelect: () => {
                    const rest = p.lists.filter((x) => x.id !== l.id);
                    save({ lists: rest, active: rest[0]!.id });
                  },
                },
              ]}
            >
              <button
                type="button"
                role="tab"
                className="wl-tab"
                aria-selected={l.id === list.id}
                onClick={() => save({ active: l.id })}
              >
                {l.name}
              </button>
            </ContextMenu>
          ))}
          <button type="button" className="wl-tab wl-tab-add" onClick={addList}>
            + list
          </button>
        </div>
        <div className="grow" />
        <DropdownMenu
          align="end"
          items={(Object.keys(LINK_COLORS) as LinkColor[]).map((c) => ({
            id: c,
            label: c === 'none' ? 'No link' : `Link: ${c[0]!.toUpperCase()}${c.slice(1)}`,
            checked: c === p.link,
            onSelect: () => save({ link: c }),
          }))}
          trigger={
            <button
              type="button"
              className="link-dot"
              aria-label={`Link group: ${p.link}`}
              title="Link group"
            >
              <span style={{ background: LINK_COLORS[p.link] }} />
            </button>
          }
        />
        <DropdownMenu
          align="end"
          items={[
            { kind: 'label', id: 'l', label: 'Columns' },
            ...COLUMNS.map((c) => ({
              id: c.id,
              label: c.label,
              checked: p.columns.includes(c.id),
              onSelect: () =>
                save({
                  columns: p.columns.includes(c.id)
                    ? p.columns.filter((x) => x !== c.id)
                    : COLUMNS.map((x) => x.id).filter((x) => x === c.id || p.columns.includes(x)),
                }),
            })),
            { kind: 'separator', id: 's' },
            {
              id: 'reset',
              label: 'Reset to default',
              onSelect: () => save({ columns: DEFAULT_COLUMNS }),
            },
            {
              id: 'manual',
              label: 'Manual order (clear sort)',
              disabled: !p.sort,
              onSelect: () => save({ sort: null }),
            },
          ]}
          trigger={
            <MenuTrigger aria-label="Columns">
              <Columns3 size={13} />
            </MenuTrigger>
          }
        />
        <InstrumentPickerButton
          className="wl-add"
          testId="wl-add-symbol"
          mode="add"
          onPick={(e) => {
            if (list.symbols.includes(e.key)) {
              toast('info', `${e.symbol} is already in ${list.name}`);
              return;
            }
            setList([...list.symbols, e.key]);
          }}
        >
          <Plus size={12} /> Symbol
        </InstrumentPickerButton>
      </div>
      <div className="wl-head" role="row">
        <button type="button" onClick={() => sortBy('symbol')}>
          Symbol{arrow('symbol')}
        </button>
        {p.columns.map((c) => (
          <button
            key={c}
            type="button"
            className={c === 'spark' ? '' : 'r'}
            onClick={() => sortBy(c)}
          >
            {COLUMNS.find((x) => x.id === c)!.label}
            {arrow(c)}
          </button>
        ))}
      </div>
      <div className="wl-body" role="table" aria-label={`${list.name} watchlist`}>
        {ids.map((id) => (
          <Row
            key={id}
            id={id}
            index={list.symbols.indexOf(id)}
            entry={pickerEntryFor(id, entries)}
            columns={p.columns}
            selected={selected === id}
            draggable={!p.sort}
            onSelect={() => {
              setSelected(id);
              const f = pickerEntryFor(id, entries)?.feeds[0]?.id;
              if (f) driveLinked(p.link, f);
            }}
            onRemove={() => setList(list.symbols.filter((x) => x !== id))}
            onDrop={(from, to) => setList(moveItem(list.symbols, from, to))}
            onValues={(k, v) => {
              values.current.set(k, v);
            }}
          />
        ))}
        {!ids.length && (
          <div className="tbl-empty">Empty list — add instruments with + Symbol.</div>
        )}
      </div>
    </div>
  );
}

registerModule({ id: 'watchlist', view: Watchlist });
