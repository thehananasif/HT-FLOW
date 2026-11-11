import { useEffect, useMemo, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Chip, IconButton, Input, Select, alpha, theme } from '@htflow/ui-kit';
import { formatPrice, formatQty, type MarketStore } from '@htflow/market-data';
import {
  PriceStatsAccumulator,
  TradeCursor,
  autoGrouping,
  groupLevels,
  pocOf,
  priceStats,
  rangeStart,
  sortLevels,
  type LevelSortKey,
  type PriceLevelStats,
  type RangeKind,
} from '@htflow/tape';
import { useMarketStore } from '../../charts/useMarket';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  InstrumentPicker,
  fmtDuration,
  fmtTime,
  num,
  oneOf,
  useFollowedInstrument,
} from '../smart-tape/shared';
import '../smart-tape/styles.css';
import './styles.css';

const RANGES: { id: RangeKind; label: string }[] = [
  { id: 'session', label: 'Session' },
  { id: 'visible', label: 'Visible' },
  { id: 'week', label: 'Week' },
];

const COLS: { id: LevelSortKey; label: string }[] = [
  { id: 'px', label: 'Price' },
  { id: 'volume', label: 'Volume' },
  { id: 'bidVol', label: 'Bid' },
  { id: 'askVol', label: 'Ask' },
  { id: 'delta', label: 'Delta' },
  { id: 'trades', label: 'Trades' },
  { id: 'timeMs', label: 'Time' },
  { id: 'lastSeen', label: 'Last seen' },
];
const SORT_KEYS = COLS.map((c) => c.id);

function parse(raw: Record<string, unknown> | undefined) {
  const r = raw ?? {};
  return {
    instrumentId: typeof r.instrumentId === 'string' ? r.instrumentId : null,
    range: oneOf(r.range, ['session', 'visible', 'week'] as const, 'session'),
    /** Length of the rolling "Visible" range, minutes. */
    visibleMin: num(r.visibleMin, 60, 5, 1440),
    sessionHour: num(r.sessionHour, 0, 0, 23),
    /** Ticks per row; 0 = automatic. */
    group: num(r.group, 0, 0, 10_000),
    sortKey: oneOf(r.sortKey, SORT_KEYS, 'px'),
    sortDir: oneOf(r.sortDir, ['asc', 'desc'] as const, 'desc'),
  };
}
type Params = ReturnType<typeof parse>;

interface Snapshot {
  levels: PriceLevelStats[];
  poc: number;
  g: number;
  totalVolume: number;
  now: number;
}

/** Recomputes per-price stats once per second (session / week incrementally, visible rolling). */
function useLevels(store: MarketStore, p: Params): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const inc = useRef<{ key: string; acc: PriceStatsAccumulator; cur: TradeCursor } | null>(null);
  useEffect(() => {
    inc.current = null;
    const run = () => {
      if (!store.ready) return;
      const now = store.lastTs || Date.now();
      const opts = { sessionStartHourUtc: p.sessionHour, visibleMs: p.visibleMin * 60_000 };
      const from = rangeStart(p.range, now, opts);
      let levels: PriceLevelStats[];
      let totalVolume: number;
      if (p.range === 'visible') {
        const r = priceStats(store.trades, from, Number.POSITIVE_INFINITY, now);
        levels = r.levels;
        totalVolume = r.totalVolume;
      } else {
        const key = `${p.range}:${from}`;
        if (inc.current?.key !== key) {
          const cur = new TradeCursor();
          cur.seek(store.trades, from);
          inc.current = { key, acc: new PriceStatsAccumulator(), cur };
        }
        const { acc, cur } = inc.current;
        const [a, b] = cur.next(store.trades);
        acc.addRange(store.trades, a, b);
        levels = acc.snapshot(now);
        totalVolume = acc.totalVolume;
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const l of levels) {
        if (l.px < lo) lo = l.px;
        if (l.px > hi) hi = l.px;
      }
      const g = p.group || autoGrouping(levels.length ? hi - lo + 1 : 1, 150);
      const grouped = groupLevels(levels, g);
      setSnap({ levels: grouped, poc: pocOf(grouped), g, totalVolume, now });
    };
    run();
    const i = setInterval(run, 1000);
    const u = store.subscribe(() => {
      if (!inc.current && store.ready) run();
    });
    return () => {
      clearInterval(i);
      u();
    };
  }, [store, p.range, p.visibleMin, p.sessionHour, p.group]);
  return snap;
}

const ROW = 22;

function AllPrices({ state, setParams }: ModuleViewProps) {
  const p = parse(state.params);
  const instrumentId = useFollowedInstrument(p.instrumentId);
  const store = useMarketStore(instrumentId);
  const inst = store.instrument;
  const snap = useLevels(store, p);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [showSettings, setShowSettings] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Params>) => setParams(patch);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(
    () => (snap ? sortLevels([...snap.levels], p.sortKey, p.sortDir) : []),
    [snap, p.sortKey, p.sortDir],
  );
  const maxVol = rows.reduce((a, l) => Math.max(a, l.volume), 0);
  const maxDelta = rows.reduce((a, l) => Math.max(a, Math.abs(l.delta)), 0);
  const maxTime = rows.reduce((a, l) => Math.max(a, l.timeMs), 0);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 5);
  const last = Math.min(rows.length, first + Math.ceil(height / ROW) + 10);
  const t = theme();
  const qp = inst.qtyPrecision;
  const q = (v: number) => formatQty(v, qp);
  const lastPx = store.lastTrade?.px;

  const sortBy = (k: LevelSortKey) =>
    set(
      p.sortKey === k
        ? { sortDir: p.sortDir === 'desc' ? 'asc' : 'desc' }
        : { sortKey: k, sortDir: 'desc' },
    );

  return (
    <div className="module-window ap-win" data-testid="all-prices">
      <div className="an-toolbar">
        <InstrumentPicker
          fixed={p.instrumentId}
          current={instrumentId}
          onChange={(id) => set({ instrumentId: id })}
        />
        <span className="an-sub">
          {RANGES.find((r) => r.id === p.range)!.label.toLowerCase()} ·{' '}
          {snap && snap.g > 1 ? `${snap.g} ticks/row` : 'per tick'}
        </span>
        <span className="grow" />
        {RANGES.map((r) => (
          <Chip key={r.id} selected={p.range === r.id} onClick={() => set({ range: r.id })}>
            {r.label}
          </Chip>
        ))}
        <IconButton
          label="All Prices settings"
          active={showSettings}
          onClick={() => setShowSettings((x) => !x)}
        >
          <Settings2 size={13} />
        </IconButton>
      </div>
      {showSettings && (
        <div className="tape-filters">
          <label>
            Visible range (min)
            <Input
              type="number"
              min={5}
              max={1440}
              value={p.visibleMin}
              onChange={(e) => set({ visibleMin: num(Number(e.target.value), 60, 5, 1440) })}
            />
          </label>
          <label>
            Session starts (UTC hour)
            <Input
              type="number"
              min={0}
              max={23}
              value={p.sessionHour}
              onChange={(e) =>
                set({ sessionHour: Math.round(num(Number(e.target.value), 0, 0, 23)) })
              }
            />
          </label>
          <label>
            Ticks per row
            <Select
              small
              value={String(p.group)}
              options={[0, 1, 2, 5, 10, 25, 50, 100].map((g) => ({
                value: String(g),
                label: g ? String(g) : 'Auto',
              }))}
              onChange={(v) => set({ group: Number(v) })}
            />
          </label>
          <button
            className="ht-btn ht-btn--xs"
            onClick={() =>
              set({ visibleMin: 60, sessionHour: 0, group: 0, sortKey: 'px', sortDir: 'desc' })
            }
          >
            Reset to default
          </button>
        </div>
      )}
      <div className="ap-head tnum">
        {COLS.map((c) => (
          <button
            key={c.id}
            className={`ap-c ap-${c.id}`}
            data-sorted={p.sortKey === c.id ? p.sortDir : undefined}
            onClick={() => sortBy(c.id)}
          >
            {c.label}
            {p.sortKey === c.id ? (p.sortDir === 'desc' ? ' ▾' : ' ▴') : ''}
          </button>
        ))}
      </div>
      <div
        ref={bodyRef}
        className="ap-body tnum"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((l, i) => {
            const isPoc = l.px === snap?.poc;
            const atLast = lastPx !== undefined && snap && lastPx >= l.px && lastPx < l.px + snap.g;
            const dA = maxDelta > 0 ? (Math.abs(l.delta) / maxDelta) * 0.4 : 0;
            return (
              <div
                key={l.px}
                className="ap-row"
                data-poc={isPoc || undefined}
                data-last={atLast || undefined}
                data-testid={isPoc ? 'all-prices-poc' : undefined}
                style={{ top: (first + i) * ROW }}
              >
                <span className="ap-c ap-px">{formatPrice(l.px, inst)}</span>
                <span className="ap-c ap-volume">
                  <i
                    style={{
                      width: `${maxVol ? (l.volume / maxVol) * 100 : 0}%`,
                      background: alpha(t.clusterStrong, isPoc ? 0.75 : 0.45),
                    }}
                  />
                  <b>{q(l.volume)}</b>
                </span>
                <span className="ap-c up">{q(l.bidVol)}</span>
                <span className="ap-c down">{q(l.askVol)}</span>
                <span
                  className={`ap-c ${l.delta >= 0 ? 'up' : 'down'}`}
                  style={{ background: alpha(l.delta >= 0 ? t.up : t.down, dA) }}
                >
                  {l.delta > 0 ? '+' : ''}
                  {q(l.delta)}
                </span>
                <span className="ap-c">{l.trades}</span>
                <span
                  className="ap-c muted"
                  style={{
                    background: alpha(t.warning, maxTime ? (l.timeMs / maxTime) * 0.25 : 0),
                  }}
                >
                  {fmtDuration(l.timeMs)}
                </span>
                <span className="ap-c muted">{fmtTime(l.lastSeen, false)}</span>
              </div>
            );
          })}
        </div>
        {!rows.length && (
          <div className="tbl-empty">{store.ready ? 'No trades in range' : 'Loading…'}</div>
        )}
      </div>
      <div className="an-footer tnum">
        POC {snap && !Number.isNaN(snap.poc) ? formatPrice(snap.poc, inst) : '—'} highlighted ·{' '}
        {rows.length} rows · volume {snap ? q(snap.totalVolume) : '—'} · bid = sold into bid, ask =
        bought at ask · sort by any column
      </div>
    </div>
  );
}

registerModule({ id: 'all-prices', view: AllPrices });
