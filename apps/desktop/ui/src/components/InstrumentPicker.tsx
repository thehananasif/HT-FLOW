import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Clock, Search, Star } from 'lucide-react';
import { Badge, Button, Checkbox } from '@htflow/ui-kit';
import { catalog } from '@htflow/market-catalog';
import { isTauri } from '../backend';
import { runCommand } from '../shell/commands';
import {
  CONNECTED_GROUP,
  loadPickerPrefs,
  pickerEntries,
  usePickerPrefs,
  type FeedKind,
  type PickerEntry,
} from '../state/instruments';
import './InstrumentPicker.css';

const ROW_H = 24;

/** Status badge used by the picker and the watchlist. */
export function FeedStatusBadge({ entry }: { entry: Pick<PickerEntry, 'status' | 'desktopOnly'> }) {
  const s: FeedKind = entry.status;
  if (s === 'live') return <Badge kind="live">Live</Badge>;
  if (s === 'sim') return <Badge kind="replay">Sim</Badge>;
  if (s === 'replay') return <Badge kind="replay">Replay</Badge>;
  if (s === 'delayed') return <Badge kind="delayed">Delayed</Badge>;
  return <Badge>{entry.desktopOnly ? 'Desktop app' : 'No feed'}</Badge>;
}

function formatTick(t: number): string {
  if (t >= 1) return String(t);
  return t.toFixed(Math.min(8, Math.max(2, -Math.floor(Math.log10(t)) + 2))).replace(/0+$/, '');
}

type TreeNode = string; // 'all' | 'fav' | 'recent' | 'g:<group>' | 's:<group>/<sub>'

export interface InstrumentPickerProps {
  anchor: HTMLElement | null;
  onClose(): void;
  /** Current instrument (feed id or catalog id) — highlighted. */
  value?: string;
  /**
   * Called with the entry and the feed id to open (null when the entry has no feed). In 'open'
   * mode entries without a feed are not picked: the picker offers Connections instead.
   */
  onPick(entry: PickerEntry, feedId: string | null): void;
  mode?: 'open' | 'add';
}

/** P04 instrument picker: tree, fuzzy search, favourites, recent, "Has live feed" filter. */
export function InstrumentPicker({
  anchor,
  onClose,
  value,
  onPick,
  mode = 'open',
}: InstrumentPickerProps) {
  const prefs = usePickerPrefs();
  const entries = useMemo(() => pickerEntries(isTauri), []);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const tree = useMemo(() => {
    const t = catalog().tree();
    const connected = new Map<string, string[]>();
    for (const e of entries)
      if (e.group === CONNECTED_GROUP)
        connected.set(e.subGroup, [...(connected.get(e.subGroup) ?? []), e.key]);
    if (connected.size)
      t.push({
        name: CONNECTED_GROUP,
        subGroups: [...connected].map(([name, ids]) => ({ name, ids })),
      });
    return t;
  }, [entries]);
  const [query, setQuery] = useState('');
  const [node, setNode] = useState<TreeNode>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({ 'US and EU Futures': true });
  const [liveOnly, setLiveOnly] = useState(false);
  const [active, setActive] = useState(0);
  const [noFeed, setNoFeed] = useState<PickerEntry | null>(null);
  const [scroll, setScroll] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 8, top: 40 });

  useEffect(loadPickerPrefs, []);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(860, window.innerWidth - 16);
    const h = Math.min(480, window.innerHeight - 16);
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
      top: r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4,
    });
  }, [anchor]);

  // Close on outside click.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      if (anchor?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [anchor, onClose]);

  const memberIds = useMemo(() => {
    if (node === 'all') return null;
    if (node === 'fav') return new Set(prefs.favourites);
    if (node === 'recent') return new Set(prefs.recent);
    const [g, s] = node.slice(2).split('/');
    const grp = tree.find((x) => x.name === g);
    const subs = node.startsWith('s:')
      ? grp?.subGroups.filter((x) => x.name === s)
      : grp?.subGroups;
    return new Set((subs ?? []).flatMap((x) => x.ids));
  }, [node, tree, prefs.favourites, prefs.recent]);

  const rows = useMemo(() => {
    const keep = (e: PickerEntry) =>
      (!memberIds || memberIds.has(e.key)) && (!liveOnly || e.status !== 'none');
    let list: PickerEntry[];
    if (query.trim()) {
      const fav = new Set(prefs.favourites);
      const ids = new Set(entries.map((e) => e.key));
      const hits = catalog().index.search(query, {
        limit: 400,
        boost: (d) => (fav.has(d.id) ? 40 : 0) + (byKey.get(d.id)?.status !== 'none' ? 25 : 0),
      });
      list = hits.map((h) => byKey.get(h.doc.id)).filter((e): e is PickerEntry => !!e && keep(e));
      // Feeds the catalog does not know: plain substring match.
      const q = query.trim().toLowerCase();
      for (const e of entries)
        if (e.group === CONNECTED_GROUP && ids.has(e.key) && keep(e))
          if ((e.symbol + ' ' + e.name + ' ' + e.exchange).toLowerCase().includes(q)) list.push(e);
    } else if (node === 'recent') {
      list = prefs.recent.map((k) => byKey.get(k)).filter((e): e is PickerEntry => !!e && keep(e));
    } else {
      list = entries.filter(keep);
    }
    return list;
  }, [query, entries, byKey, memberIds, liveOnly, node, prefs.favourites, prefs.recent]);

  useEffect(() => {
    const i = value
      ? rows.findIndex((e) => e.key === value || e.feeds.some((f) => f.id === value))
      : -1;
    setActive(Math.max(0, i));
    // Only when the list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const ensureVisible = (i: number) => {
    const el = listRef.current;
    if (!el) return;
    if (i * ROW_H < el.scrollTop) el.scrollTop = i * ROW_H;
    else if ((i + 1) * ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = (i + 1) * ROW_H - el.clientHeight;
  };

  const pick = (e: PickerEntry | undefined) => {
    if (!e) return;
    const feed = e.feeds[0]?.id ?? null;
    if (!feed && mode === 'open') {
      setNoFeed(e);
      return;
    }
    prefs.pushRecent(e.key);
    onPick(e, feed);
    onClose();
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    } else if (
      ev.key === 'ArrowDown' ||
      ev.key === 'ArrowUp' ||
      ev.key === 'PageDown' ||
      ev.key === 'PageUp'
    ) {
      ev.preventDefault();
      const step = ev.key.startsWith('Page') ? 15 : 1;
      const dir = ev.key === 'ArrowDown' || ev.key === 'PageDown' ? 1 : -1;
      const n = Math.max(0, Math.min(rows.length - 1, active + dir * step));
      setActive(n);
      setNoFeed(null);
      ensureVisible(n);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      pick(rows[active]);
    }
  };

  const h = listRef.current?.clientHeight ?? 360;
  const first = Math.max(0, Math.floor(scroll / ROW_H) - 5);
  const last = Math.min(rows.length, Math.ceil((scroll + h) / ROW_H) + 5);

  const treeItem = (
    id: TreeNode,
    label: ReactNode,
    depth: number,
    count?: number,
    toggle?: string,
  ) => (
    <button
      key={id}
      type="button"
      className="ip-node"
      data-depth={depth}
      aria-current={node === id}
      onClick={() => {
        setNode(id);
        setQuery('');
        if (toggle) setOpen((o) => ({ ...o, [toggle]: !o[toggle] }));
      }}
    >
      {toggle ? open[toggle] ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
      <span className="ip-node-label">{label}</span>
      {count !== undefined && <span className="ip-count tnum">{count}</span>}
    </button>
  );

  return createPortal(
    <div
      ref={rootRef}
      className="ip-root"
      role="dialog"
      aria-label="Instrument picker"
      style={{ left: pos.left, top: pos.top }}
      tabIndex={-1}
      onKeyDown={onKey}
      data-testid="instrument-picker-popover"
    >
      <nav className="ip-tree" aria-label="Market catalog">
        {treeItem('all', 'All markets', 0, entries.length)}
        {treeItem(
          'fav',
          <>
            <Star size={11} /> Favourites
          </>,
          0,
          prefs.favourites.length,
        )}
        {treeItem(
          'recent',
          <>
            <Clock size={11} /> Recent
          </>,
          0,
          prefs.recent.length,
        )}
        {tree.map((g) => (
          <div key={g.name}>
            {treeItem(`g:${g.name}`, g.name, 0, undefined, g.name)}
            {open[g.name] &&
              g.subGroups.map((s) => treeItem(`s:${g.name}/${s.name}`, s.name, 1, s.ids.length))}
          </div>
        ))}
      </nav>
      <div className="ip-main">
        <div className="ip-bar">
          <Search size={13} className="muted" />
          <input
            autoFocus
            className="ip-search"
            placeholder="Search symbol, name, root or exchange…"
            aria-label="Search instruments"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setNoFeed(null);
              if (listRef.current) listRef.current.scrollTop = 0;
            }}
          />
          <Checkbox checked={liveOnly} onChange={setLiveOnly} label="Has live feed" />
        </div>
        <div className="ip-head">
          <span />
          <span>Symbol</span>
          <span>Name</span>
          <span>Exchange</span>
          <span className="r">Tick size</span>
          <span>Status</span>
        </div>
        <div
          className="ip-list"
          ref={listRef}
          role="listbox"
          aria-label="Instruments"
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            {rows.slice(first, last).map((e, k) => {
              const i = first + k;
              const fav = prefs.favourites.includes(e.key);
              const front = e.catalog?.contract ? catalog().frontCode(e.catalog) : null;
              return (
                <div
                  key={e.key}
                  role="option"
                  aria-selected={i === active}
                  data-current={!!value && (e.key === value || e.feeds.some((f) => f.id === value))}
                  className="ip-row"
                  style={{ top: i * ROW_H }}
                  title={
                    e.feeds.length ? `Opens ${e.feeds[0]!.id} (${e.feeds[0]!.label})` : undefined
                  }
                  onClick={() => {
                    setActive(i);
                    setNoFeed(null);
                  }}
                  onDoubleClick={() => pick(e)}
                >
                  <button
                    type="button"
                    className="ip-star"
                    aria-label={
                      fav ? `Remove ${e.symbol} from favourites` : `Add ${e.symbol} to favourites`
                    }
                    aria-pressed={fav}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      prefs.toggleFavourite(e.key);
                    }}
                  >
                    <Star size={11} fill={fav ? 'currentColor' : 'none'} />
                  </button>
                  <span className="mono ip-sym">
                    {e.symbol}
                    {front && front !== e.symbol && <span className="ip-front">{front}</span>}
                  </span>
                  <span className="ip-name">{e.name}</span>
                  <span className="muted">{e.exchange}</span>
                  <span className="r tnum">{formatTick(e.tickSize)}</span>
                  <span className="ip-status">
                    <FeedStatusBadge entry={e} />
                    {e.status === 'none' && !e.desktopOnly && (
                      <button
                        type="button"
                        className="ip-connect"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onClose();
                          runCommand('open.connections');
                        }}
                      >
                        connect
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {!rows.length && <div className="ip-empty">No instruments match.</div>}
        </div>
        <div className="ip-foot">
          {noFeed ? (
            <span className="ip-nofeed" role="alert">
              <b>{noFeed.symbol}</b> has no feed —{' '}
              {noFeed.desktopOnly ? 'available in the desktop app.' : 'connect a data provider.'}
              {!noFeed.desktopOnly && (
                <Button
                  size="xs"
                  onClick={() => {
                    onClose();
                    runCommand('open.connections');
                  }}
                >
                  Open Connections
                </Button>
              )}
            </span>
          ) : (
            <span className="muted">
              {rows.length.toLocaleString()} instruments · ↑↓ to move · Enter / double-click to{' '}
              {mode === 'open' ? 'open' : 'add'} · Esc to close
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Header-style trigger that opens the picker. */
export function InstrumentPickerButton({
  value,
  onPick,
  children,
  className,
  mode,
  testId,
  ariaLabel,
}: {
  value?: string;
  onPick: InstrumentPickerProps['onPick'];
  children: ReactNode;
  className?: string;
  mode?: 'open' | 'add';
  testId?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <InstrumentPicker
          anchor={ref.current}
          value={value}
          mode={mode}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
