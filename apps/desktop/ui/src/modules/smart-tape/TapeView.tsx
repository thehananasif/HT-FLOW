import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, SlidersHorizontal } from 'lucide-react';
import { Checkbox, Chip, IconButton, Input, Select, alpha, theme } from '@htflow/ui-kit';
import {
  formatCompact,
  formatPrice,
  formatQty,
  type Instrument,
  type MarketStore,
} from '@htflow/market-data';
import {
  SpeedMeter,
  TapeBuffer,
  TradeCursor,
  autoThresholds,
  bigPrintThreshold,
  deltaOf,
  normalizeFilter,
  passesRaw,
  quoteAt,
  sessionStart,
  sizeBucket,
  type AggregateMode,
  type SideFilter,
  type TapeFilter,
} from '@htflow/tape';
import { useMarketStore } from '../../charts/useMarket';
import type { ModuleViewProps } from '../registry';
import {
  InstrumentPicker,
  beep,
  fmtTime,
  num,
  oneOf,
  primeAudio,
  useFollowedInstrument,
} from './shared';
import './styles.css';

export type TapeVariant = 'smart' | 'bidask';

export const SMART_COLUMNS = [
  { id: 'time', label: 'Time', w: 1.55 },
  { id: 'price', label: 'Price', w: 1.2 },
  { id: 'size', label: 'Size', w: 1 },
  { id: 'side', label: 'Side', w: 0.6 },
  { id: 'bid', label: 'Bid', w: 1.1 },
  { id: 'ask', label: 'Ask', w: 1.1 },
  { id: 'cvd', label: 'CVD', w: 1.1 },
  { id: 'trades', label: 'Trades', w: 0.7 },
] as const;
type ColId = (typeof SMART_COLUMNS)[number]['id'];
const ALL_COLS = SMART_COLUMNS.map((c) => c.id);

/** Persisted tape settings (validated; every field has a default). */
export interface TapeParams {
  instrumentId: string | null;
  /** Price bounds in price units (converted to ticks for filtering). */
  filter: TapeFilter;
  agg: AggregateMode;
  windowMs: number;
  /** 0 = automatic (99th percentile of recent prints). */
  bigSize: number;
  sound: boolean;
  buckets: boolean;
  cols: ColId[];
}

export function parseTapeParams(raw: Record<string, unknown> | undefined) {
  const r = raw ?? {};
  const cols = Array.isArray(r.cols)
    ? (r.cols as unknown[]).filter((c): c is ColId => ALL_COLS.includes(c as ColId))
    : [...ALL_COLS];
  return {
    instrumentId: typeof r.instrumentId === 'string' ? r.instrumentId : null,
    filter: normalizeFilter((r.filter ?? {}) as Partial<Record<keyof TapeFilter, unknown>>),
    agg: oneOf(r.agg, ['none', 'timestamp', 'window'] as const, 'timestamp'),
    windowMs: num(r.windowMs, 50, 1, 5000),
    bigSize: num(r.bigSize, 0, 0),
    sound: r.sound === true,
    buckets: r.buckets !== false,
    cols: cols.length ? cols : [...ALL_COLS],
  } satisfies TapeParams;
}

const HISTORY_PRINTS = 20_000;
const ROW = 20;
const HEAD = 22;

interface Engine {
  buf: TapeBuffer;
  speed: SpeedMeter;
  cursor: TradeCursor;
  /** Prints with index < liveFrom (by total) came from history: no sound for them. */
  liveFrom: number;
  thresholds: number[];
  big: number;
}

function buildEngine(store: MarketStore, agg: AggregateMode, windowMs: number): Engine {
  const buf = new TapeBuffer(65_536, { mode: agg, windowMs });
  const cursor = new TradeCursor();
  const tr = store.trades;
  const start = Math.max(0, tr.length - HISTORY_PRINTS);
  const ss = sessionStart(store.lastTs || Date.now());
  // CVD baseline: session delta up to the first trade shown.
  let i0 = start;
  while (i0 > 0 && tr[i0 - 1]!.ts >= ss) i0--;
  buf.cvd = deltaOf(tr, i0, start);
  for (let i = start; i < tr.length; i++) {
    const t = tr[i]!;
    const [b, a] = quoteAt(store.depth, t.ts);
    buf.push(t, b, a);
  }
  cursor.seek(tr, Number.POSITIVE_INFINITY);
  cursor.next(tr);
  return {
    buf,
    speed: new SpeedMeter(1000, 100),
    cursor,
    liveFrom: buf.total,
    thresholds: [],
    big: Number.POSITIVE_INFINITY,
  };
}

function refreshBuckets(e: Engine, bigSize: number): void {
  const n = Math.min(e.buf.size, 3000);
  const sizes = new Float64Array(n);
  for (let k = 0; k < n; k++) sizes[k] = e.buf.qtyAt(k);
  e.thresholds = autoThresholds(sizes, [0.5, 0.8, 0.95]);
  e.big = bigPrintThreshold(bigSize, sizes);
}

interface DrawOpts {
  variant: TapeVariant;
  inst: Instrument;
  filter: TapeFilter;
  cols: ColId[];
  buckets: boolean;
  scroll: number;
  paused: boolean;
}

function draw(c: HTMLCanvasElement, w: number, h: number, e: Engine, o: DrawOpts): void {
  const ctx = c.getContext('2d');
  if (!ctx || w < 10) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = theme();
  ctx.fillStyle = t.chartBg;
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  const font = (bold: boolean) =>
    `${bold ? 600 : 400} 11px "Geist", "Segoe UI", sans-serif`;
  const px = (v: number) => (Number.isNaN(v) ? '—' : formatPrice(v, o.inst));
  const qp = o.inst.qtyPrecision;

  // Columns
  type Col = { id: string; label: string; x: number; w: number; align: 'left' | 'right' | 'center' };
  let cols: Col[];
  if (o.variant === 'smart') {
    const vis = SMART_COLUMNS.filter((cc) => o.cols.includes(cc.id));
    const tw = vis.reduce((a, cc) => a + cc.w, 0);
    let x = 0;
    cols = vis.map((cc) => {
      const cw = (cc.w / tw) * w;
      const r: Col = { id: cc.id, label: cc.label, x, w: cw, align: cc.id === 'time' ? 'left' : 'right' };
      x += cw;
      return r;
    });
  } else {
    const tw = w * 0.26;
    const rest = (w - tw) / 3;
    cols = [
      { id: 'time', label: 'Time', x: 0, w: tw, align: 'left' },
      { id: 'sell', label: 'Bid (sell)', x: tw, w: rest, align: 'right' },
      { id: 'price', label: 'Price', x: tw + rest, w: rest, align: 'center' },
      { id: 'buy', label: 'Ask (buy)', x: tw + 2 * rest, w: rest, align: 'left' },
    ];
  }
  const text = (s: string, cc: Col, y: number) => {
    const pad = 8;
    if (cc.align === 'left') {
      ctx.textAlign = 'left';
      ctx.fillText(s, cc.x + pad, y);
    } else if (cc.align === 'right') {
      ctx.textAlign = 'right';
      ctx.fillText(s, cc.x + cc.w - pad, y);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(s, cc.x + cc.w / 2, y);
    }
  };

  // Header
  ctx.fillStyle = t.surface1;
  ctx.fillRect(0, 0, w, HEAD);
  ctx.fillStyle = t.border;
  ctx.fillRect(0, HEAD - 1, w, 1);
  ctx.font = font(false);
  ctx.fillStyle = t.textSecondary;
  for (const cc of cols) text(cc.label.toUpperCase(), cc, HEAD / 2);

  // Collect visible rows (newest first, filtered), skipping `scroll` passing rows.
  const rowsN = Math.ceil((h - HEAD) / ROW);
  const f = o.filter;
  const ks: number[] = [];
  let skip = o.scroll;
  for (let k = 0; k < e.buf.size && ks.length < rowsN; k++) {
    if (!passesRaw(f, e.buf.qtyAt(k), e.buf.sideAt(k), e.buf.pxAt(k))) continue;
    if (skip > 0) {
      skip--;
      continue;
    }
    ks.push(k);
  }
  let maxQ = 0;
  if (o.variant === 'bidask') for (const k of ks) maxQ = Math.max(maxQ, e.buf.qtyAt(k));
  const BUCKET_A = [0, 0.05, 0.1, 0.16];

  ks.forEach((k, r) => {
    const y = HEAD + r * ROW;
    const cy = y + ROW / 2;
    const side = e.buf.sideAt(k);
    const q = e.buf.qtyAt(k);
    const big = q >= e.big;
    const sc = side > 0 ? t.up : side < 0 ? t.down : t.textSecondary;
    const bucket = sizeBucket(q, e.thresholds);
    if (o.variant === 'smart') {
      const a = big ? 0.28 : o.buckets ? (BUCKET_A[bucket] ?? 0.16) : 0;
      if (a > 0 && side !== 0) {
        ctx.fillStyle = alpha(sc, a);
        ctx.fillRect(0, y, w, ROW);
      }
    } else if (big) {
      ctx.fillStyle = alpha(sc, 0.12);
      ctx.fillRect(0, y, w, ROW);
    }
    ctx.fillStyle = t.divider;
    ctx.fillRect(0, y + ROW - 1, w, 1);
    ctx.font = font(big);
    for (const cc of cols) {
      let s = '';
      let color = t.textSoft;
      switch (cc.id) {
        case 'time':
          s = fmtTime(e.buf.tsAt(k));
          color = t.textSecondary;
          break;
        case 'price':
          s = px(e.buf.pxAt(k));
          color = o.variant === 'smart' ? sc : t.textPrimary;
          break;
        case 'size':
          s = formatQty(q, qp);
          color = sc;
          break;
        case 'side':
          s = side > 0 ? 'B' : side < 0 ? 'S' : '·';
          color = sc;
          break;
        case 'bid':
          s = px(e.buf.bidAt(k));
          color = t.textSecondary;
          break;
        case 'ask':
          s = px(e.buf.askAt(k));
          color = t.textSecondary;
          break;
        case 'cvd': {
          const v = e.buf.cvdAt(k);
          s = (v > 0 ? '+' : '') + formatCompact(Number(v.toFixed(qp)));
          color = v >= 0 ? t.up : t.down;
          break;
        }
        case 'trades':
          s = String(e.buf.tradesAt(k));
          color = t.textSecondary;
          break;
        case 'sell':
        case 'buy': {
          const mine = cc.id === 'buy' ? side > 0 : side < 0;
          if (!mine) break;
          const bw = maxQ > 0 ? Math.max(2, (q / maxQ) * (cc.w - 12)) : 0;
          ctx.fillStyle = alpha(sc, big ? 0.45 : 0.22);
          if (cc.id === 'sell') ctx.fillRect(cc.x + cc.w - 4 - bw, y + 3, bw, ROW - 6);
          else ctx.fillRect(cc.x + 4, y + 3, bw, ROW - 6);
          s = formatQty(q, qp);
          color = sc;
          break;
        }
      }
      if (!s) continue;
      ctx.fillStyle = color;
      text(s, cc, cy);
    }
  });
  if (!ks.length) {
    ctx.fillStyle = t.textTertiary;
    ctx.textAlign = 'center';
    ctx.font = font(false);
    ctx.fillText(e.buf.size ? 'No prints match the filters' : 'Waiting for prints…', w / 2, HEAD + 30);
  }
  if (o.paused) {
    ctx.fillStyle = alpha(t.warning, 0.9);
    ctx.fillRect(0, HEAD, 2, h - HEAD);
  }
}

export function TapeView({
  state,
  setParams,
  variant,
}: ModuleViewProps & { variant: TapeVariant }) {
  const p = parseTapeParams(state.params);
  const instrumentId = useFollowedInstrument(p.instrumentId);
  const store = useMarketStore(instrumentId);
  const inst = store.instrument;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stress, setStress] = useState(false);
  const [meter, setMeter] = useState({ pps: 0, vps: 0, big: Number.POSITIVE_INFINITY });
  const ui = useRef({ p, paused, scroll: 0, stress, dirty: true });
  ui.current.p = p;
  ui.current.paused = paused;
  ui.current.stress = stress;
  const set = (patch: Partial<TapeParams>) => setParams(patch as Record<string, unknown>);
  const setFilter = (patch: Partial<Record<keyof TapeFilter, unknown>>) =>
    set({ filter: normalizeFilter({ ...p.filter, ...patch }) });

  useEffect(() => {
    const c = canvasRef.current!;
    const wrap = wrapRef.current!;
    let w = 0;
    let h = 0;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      w = r.width;
      h = r.height;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      ui.current.dirty = true;
    });
    ro.observe(wrap);
    let e: Engine | null = null;
    let raf = 0;
    let lastMeter = 0;
    let lastBuckets = 0;
    let lastVersion = -1;
    let stressT = performance.now();
    let stressId = 1e12;
    let lastKey = '';
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const u = ui.current;
      if (!store.ready) return;
      if (!e) {
        e = buildEngine(store, u.p.agg, u.p.windowMs);
        refreshBuckets(e, u.p.bigSize);
      }
      // Ingest new trades (at most once per frame) with the current best bid / ask.
      const [from, to] = e.cursor.next(store.trades);
      const bb = store.book.bestBid;
      const ba = store.book.bestAsk;
      const tick = inst.tickSize;
      const f = u.p.filter;
      const ft: TapeFilter = {
        ...f,
        minPx: f.minPx === null ? null : Math.round(f.minPx / tick),
        maxPx: f.maxPx === null ? null : Math.round(f.maxPx / tick),
      };
      let soundSide = 0;
      const ingest = (tr: (typeof store.trades)[number], b: number, a: number) => {
        const created = e!.buf.push(tr, b, a);
        e!.speed.add(tr.ts, tr.qty, created ? 1 : 0);
        const q = e!.buf.qtyAt(0);
        if (u.p.sound && q >= e!.big && passesRaw(ft, q, e!.buf.sideAt(0), tr.px))
          soundSide = e!.buf.sideAt(0) || 1;
      };
      for (let i = from; i < to; i++) ingest(store.trades[i]!, bb, ba);
      if (u.stress) {
        // Diagnostics: synthetic 5,000 prints/s injected into this tape only.
        const now = performance.now();
        const n = Math.min(2000, Math.round((now - stressT) * 5));
        stressT = now;
        const base = store.lastTrade?.px ?? 0;
        const ts = store.lastTs || Date.now();
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? 'buy' : 'sell';
          ingest(
            {
              ts: ts + i * 1e-3,
              px: base + Math.round((Math.random() - 0.5) * 6),
              qty: Number((Math.random() * Math.random() * 10).toFixed(inst.qtyPrecision)) || 1,
              side,
              id: stressId++,
            },
            bb,
            ba,
          );
        }
      } else stressT = performance.now();
      if (soundSide) beep(soundSide);
      const now = performance.now();
      if (now - lastBuckets > 2000) {
        lastBuckets = now;
        refreshBuckets(e, u.p.bigSize);
      }
      if (now - lastMeter > 500) {
        lastMeter = now;
        const r = e.speed.rate(store.lastTs || Date.now());
        setMeter({ pps: r.printsPerSec, vps: r.volPerSec, big: e.big });
      }
      const key = JSON.stringify(u.p) + u.paused;
      if (key !== lastKey) {
        lastKey = key;
        u.dirty = true;
      }
      // Paused (hover): only scroll / resize / settings redraw; new prints keep buffering.
      if (!u.dirty && (u.paused || e.buf.version === lastVersion)) return;
      lastVersion = e.buf.version;
      u.dirty = false;
      draw(c, w, h, e, {
        variant,
        inst,
        filter: ft,
        cols: u.p.cols,
        buckets: u.p.buckets,
        scroll: u.paused ? u.scroll : 0,
        paused: u.paused,
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // Rebuild when the instrument or the aggregation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, p.agg, p.windowMs, variant]);

  const sizeChips = variant === 'bidask';
  return (
    <div className="module-window tape-win" data-testid={`tape-${variant}`}>
      <div className="an-toolbar">
        <InstrumentPicker
          fixed={p.instrumentId}
          current={instrumentId}
          onChange={(id) => set({ instrumentId: id })}
        />
        {sizeChips ? (
          <>
            <Chip
              selected={p.filter.minSize > 0}
              onClick={() => setShowFilters(true)}
              title="Minimum print size"
            >
              ≥ {p.filter.minSize > 0 ? formatQty(p.filter.minSize, inst.qtyPrecision) : '…'}
            </Chip>
            <Chip selected={p.filter.minSize === 0} onClick={() => setFilter({ minSize: 0 })}>
              All
            </Chip>
          </>
        ) : (
          <>
            <Chip selected={p.filter.minSize > 0} onClick={() => setShowFilters((x) => !x)}>
              Size ≥ {formatQty(p.filter.minSize, inst.qtyPrecision)}
            </Chip>
            <Chip
              selected={p.agg !== 'none'}
              onClick={() => set({ agg: p.agg === 'none' ? 'timestamp' : 'none' })}
              title="Aggregate fills into smart prints"
            >
              Aggregate
            </Chip>
          </>
        )}
        <span className="grow" />
        {paused && <span className="tape-paused">Paused</span>}
        <span className="tape-speed tnum" data-testid="tape-speed">
          {Math.round(meter.pps)} prints/s
        </span>
        <IconButton
          label={p.sound ? 'Big-print sound on' : 'Big-print sound off'}
          active={p.sound}
          onClick={() => {
            primeAudio();
            set({ sound: !p.sound });
          }}
        >
          {p.sound ? <Bell size={13} /> : <BellOff size={13} />}
        </IconButton>
        <IconButton
          label="Filters"
          active={showFilters}
          onClick={() => setShowFilters((x) => !x)}
        >
          <SlidersHorizontal size={13} />
        </IconButton>
      </div>
      {showFilters && (
        <div className="tape-filters" data-testid="tape-filters">
          <label>
            Min size
            <Input
              type="number"
              min={0}
              value={p.filter.minSize || ''}
              placeholder="0"
              onChange={(ev) => setFilter({ minSize: Number(ev.target.value) || 0 })}
            />
          </label>
          <label>
            Max size
            <Input
              type="number"
              min={0}
              value={p.filter.maxSize || ''}
              placeholder="no limit"
              onChange={(ev) => setFilter({ maxSize: Number(ev.target.value) || 0 })}
            />
          </label>
          <label>
            Side
            <Select<SideFilter>
              small
              value={p.filter.side}
              options={[
                { value: 'all', label: 'All' },
                { value: 'buy', label: 'Buys' },
                { value: 'sell', label: 'Sells' },
              ]}
              onChange={(v) => setFilter({ side: v })}
            />
          </label>
          <label>
            Price from
            <Input
              type="number"
              step={inst.tickSize}
              value={p.filter.minPx ?? ''}
              placeholder="any"
              onChange={(ev) =>
                setFilter({ minPx: ev.target.value === '' ? null : Number(ev.target.value) })
              }
            />
          </label>
          <label>
            Price to
            <Input
              type="number"
              step={inst.tickSize}
              value={p.filter.maxPx ?? ''}
              placeholder="any"
              onChange={(ev) =>
                setFilter({ maxPx: ev.target.value === '' ? null : Number(ev.target.value) })
              }
            />
          </label>
          <label>
            Aggregation
            <Select<AggregateMode>
              small
              value={p.agg}
              options={[
                { value: 'none', label: 'Off (every fill)' },
                { value: 'timestamp', label: 'Same timestamp + side' },
                { value: 'window', label: 'Time window' },
              ]}
              onChange={(v) => set({ agg: v })}
            />
          </label>
          {p.agg === 'window' && (
            <label>
              Window (ms)
              <Input
                type="number"
                min={1}
                max={5000}
                value={p.windowMs}
                onChange={(ev) => set({ windowMs: num(Number(ev.target.value), 50, 1, 5000) })}
              />
            </label>
          )}
          <label>
            Big print ≥
            <Input
              type="number"
              min={0}
              value={p.bigSize || ''}
              placeholder={`auto (${Number.isFinite(meter.big) ? formatQty(meter.big, inst.qtyPrecision) : '—'})`}
              onChange={(ev) => set({ bigSize: Math.max(0, Number(ev.target.value) || 0) })}
            />
          </label>
          {variant === 'smart' && (
            <>
              <Checkbox
                checked={p.buckets}
                onChange={(v) => set({ buckets: v })}
                label="Colour by size bucket"
              />
              <div className="tape-cols">
                {SMART_COLUMNS.map((cc) => (
                  <Checkbox
                    key={cc.id}
                    checked={p.cols.includes(cc.id)}
                    label={cc.label}
                    onChange={(v) =>
                      set({
                        cols: v
                          ? ALL_COLS.filter((x) => x === cc.id || p.cols.includes(x))
                          : p.cols.filter((x) => x !== cc.id),
                      })
                    }
                  />
                ))}
              </div>
            </>
          )}
          <Checkbox
            checked={stress}
            onChange={setStress}
            label="Load test: inject 5,000 synthetic prints/s (not saved)"
          />
          <button
            className="ht-btn ht-btn--xs"
            onClick={() =>
              set({ filter: normalizeFilter({}), agg: 'timestamp', bigSize: 0, buckets: true })
            }
          >
            Reset to default
          </button>
        </div>
      )}
      <div
        ref={wrapRef}
        className="tape-canvas-wrap"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => {
          ui.current.scroll = 0;
          setPaused(false);
        }}
        onWheel={(ev) => {
          ui.current.scroll = Math.max(0, ui.current.scroll + (ev.deltaY > 0 ? 3 : -3));
          ui.current.dirty = true;
        }}
      >
        <canvas ref={canvasRef} data-testid={`tape-canvas-${variant}`} />
      </div>
      <div className="an-footer tnum">
        {variant === 'bidask' ? 'Speed ' : ''}
        {Math.round(meter.pps)} prints/s · {formatCompact(Number(meter.vps.toFixed(2)))} vol/s ·
        big prints ≥{' '}
        {Number.isFinite(meter.big) ? formatQty(meter.big, inst.qtyPrecision) : '—'}
        {p.bigSize ? '' : ' (auto)'} · sound {p.sound ? 'on' : 'off'} · hover pauses, wheel scrolls
      </div>
    </div>
  );
}
