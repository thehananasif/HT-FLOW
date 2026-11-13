import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, SlidersHorizontal } from 'lucide-react';
import { Checkbox, Chip, IconButton, Input, Select, alpha, theme } from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
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
import { effectiveMaxFps, frameInterval } from '../../charts/settings/performance';
import { useSettingsStore } from '../../state/settings';
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
import {
  anchoredScroll,
  effectiveBigSize,
  effectiveFilter,
  effectiveSound,
  sideColor,
  tapeCapacity,
} from './globalSettings';
import './styles.css';

export type TapeVariant = 'smart' | 'bidask';

export const SMART_COLUMNS = [
  { id: 'time', label: t('tape.colTime'), w: 1.55 },
  { id: 'price', label: t('tape.colPrice'), w: 1.2 },
  { id: 'size', label: t('tape.colSize'), w: 1 },
  { id: 'side', label: t('tape.colSide'), w: 0.6 },
  { id: 'bid', label: t('tape.colBid'), w: 1.1 },
  { id: 'ask', label: t('tape.colAsk'), w: 1.1 },
  { id: 'cvd', label: t('tape.colCvd'), w: 1.1 },
  { id: 'trades', label: t('tape.colTrades'), w: 0.7 },
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

export interface Engine {
  buf: TapeBuffer;
  speed: SpeedMeter;
  cursor: TradeCursor;
  /** Prints with index < liveFrom (by total) came from history: no sound for them. */
  liveFrom: number;
  thresholds: number[];
  big: number;
}

export function buildEngine(
  store: MarketStore,
  agg: AggregateMode,
  windowMs: number,
  capacity: number,
): Engine {
  const buf = new TapeBuffer(capacity, { mode: agg, windowMs });
  const cursor = new TradeCursor();
  const tr = store.trades;
  const start = Math.max(0, tr.length - Math.min(HISTORY_PRINTS, capacity));
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

export function refreshBuckets(e: Engine, bigSize: number): void {
  const n = Math.min(e.buf.size, 3000);
  const sizes = new Float64Array(n);
  for (let k = 0; k < n; k++) sizes[k] = e.buf.qtyAt(k);
  e.thresholds = autoThresholds(sizes, [0.5, 0.8, 0.95]);
  e.big = bigPrintThreshold(bigSize, sizes);
}

export interface DrawOpts {
  variant: TapeVariant;
  inst: Instrument;
  filter: TapeFilter;
  cols: ColId[];
  buckets: boolean;
  scroll: number;
  paused: boolean;
  colorBySide: boolean;
}

export function drawTape(c: HTMLCanvasElement, w: number, h: number, e: Engine, o: DrawOpts): void {
  const ctx = c.getContext('2d');
  if (!ctx || w < 10) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const th = theme();
  ctx.fillStyle = th.chartBg;
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  const font = (bold: boolean) => `${bold ? 600 : 400} 11px "Geist", "Segoe UI", sans-serif`;
  const px = (v: number) => (Number.isNaN(v) ? '—' : formatPrice(v, o.inst));
  const qp = o.inst.qtyPrecision;

  // Columns
  type Col = {
    id: string;
    label: string;
    x: number;
    w: number;
    align: 'left' | 'right' | 'center';
  };
  let cols: Col[];
  if (o.variant === 'smart') {
    const vis = SMART_COLUMNS.filter((cc) => o.cols.includes(cc.id));
    const tw = vis.reduce((a, cc) => a + cc.w, 0);
    let x = 0;
    cols = vis.map((cc) => {
      const cw = (cc.w / tw) * w;
      const r: Col = {
        id: cc.id,
        label: cc.label,
        x,
        w: cw,
        align: cc.id === 'time' ? 'left' : 'right',
      };
      x += cw;
      return r;
    });
  } else {
    const tw = w * 0.26;
    const rest = (w - tw) / 3;
    cols = [
      { id: 'time', label: t('tape.colTime'), x: 0, w: tw, align: 'left' },
      { id: 'sell', label: t('tape.bidSell'), x: tw, w: rest, align: 'right' },
      { id: 'price', label: t('tape.colPrice'), x: tw + rest, w: rest, align: 'center' },
      { id: 'buy', label: t('tape.askBuy'), x: tw + 2 * rest, w: rest, align: 'left' },
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
  ctx.fillStyle = th.surface1;
  ctx.fillRect(0, 0, w, HEAD);
  ctx.fillStyle = th.border;
  ctx.fillRect(0, HEAD - 1, w, 1);
  ctx.font = font(false);
  ctx.fillStyle = th.textSecondary;
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
    const sc = sideColor(side, o.colorBySide, {
      up: th.up,
      down: th.down,
      neutral: th.textSecondary,
    });
    const bucket = sizeBucket(q, e.thresholds);
    if (o.variant === 'smart') {
      const a = big ? 0.28 : o.buckets ? (BUCKET_A[bucket] ?? 0.16) : 0;
      if (a > 0 && side !== 0 && o.colorBySide) {
        ctx.fillStyle = alpha(sc, a);
        ctx.fillRect(0, y, w, ROW);
      }
    } else if (big) {
      ctx.fillStyle = alpha(sc, 0.12);
      ctx.fillRect(0, y, w, ROW);
    }
    ctx.fillStyle = th.divider;
    ctx.fillRect(0, y + ROW - 1, w, 1);
    ctx.font = font(big);
    for (const cc of cols) {
      let s = '';
      let color = th.textSoft;
      switch (cc.id) {
        case 'time':
          s = fmtTime(e.buf.tsAt(k));
          color = th.textSecondary;
          break;
        case 'price':
          s = px(e.buf.pxAt(k));
          color = o.variant === 'smart' ? sc : th.textPrimary;
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
          color = th.textSecondary;
          break;
        case 'ask':
          s = px(e.buf.askAt(k));
          color = th.textSecondary;
          break;
        case 'cvd': {
          const v = e.buf.cvdAt(k);
          s = (v > 0 ? '+' : '') + formatCompact(Number(v.toFixed(qp)));
          color = v >= 0 ? th.up : th.down;
          break;
        }
        case 'trades':
          s = String(e.buf.tradesAt(k));
          color = th.textSecondary;
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
    ctx.fillStyle = th.textTertiary;
    ctx.textAlign = 'center';
    ctx.font = font(false);
    ctx.fillText(e.buf.size ? t('tape.noMatch') : t('tape.waiting'), w / 2, HEAD + 30);
  }
  if (o.paused) {
    ctx.fillStyle = alpha(th.warning, 0.9);
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
  const g = useSettingsStore((st) => st.values);
  const ui = useRef({ p, g, paused, scroll: 0, stress, dirty: true });
  ui.current.p = p;
  ui.current.g = g;
  const capacity = tapeCapacity(g);
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
    let lastFrame = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const u = ui.current;
      if (!store.ready) return;
      const tNow = performance.now();
      if (tNow - lastFrame < frameInterval(effectiveMaxFps(0, u.g))) return;
      lastFrame = tNow;
      if (!e) {
        e = buildEngine(store, u.p.agg, u.p.windowMs, capacity);
        refreshBuckets(e, effectiveBigSize(u.p.bigSize, u.g));
      }
      // Ingest new trades (at most once per frame) with the current best bid / ask.
      const [from, to] = e.cursor.next(store.trades);
      const bb = store.book.bestBid;
      const ba = store.book.bestAsk;
      const tick = inst.tickSize;
      const f = effectiveFilter(u.p.filter, u.g);
      const ft: TapeFilter = {
        ...f,
        minPx: f.minPx === null ? null : Math.round(f.minPx / tick),
        maxPx: f.maxPx === null ? null : Math.round(f.maxPx / tick),
      };
      let soundSide = 0;
      let added = 0;
      const sound = effectiveSound(u.p.sound, u.g);
      const ingest = (tr: (typeof store.trades)[number], b: number, a: number) => {
        const created = e!.buf.push(tr, b, a);
        if (created) added++;
        e!.speed.add(tr.ts, tr.qty, created ? 1 : 0);
        const q = e!.buf.qtyAt(0);
        if (sound && q >= e!.big && passesRaw(ft, q, e!.buf.sideAt(0), tr.px))
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
      if (added) u.scroll = anchoredScroll(u.scroll, added, u.g['tape.autoScroll']);
      if (soundSide) beep(soundSide);
      const now = performance.now();
      if (now - lastBuckets > 2000) {
        lastBuckets = now;
        refreshBuckets(e, effectiveBigSize(u.p.bigSize, u.g));
      }
      if (now - lastMeter > 500) {
        lastMeter = now;
        const r = e.speed.rate(store.lastTs || Date.now());
        setMeter({ pps: r.printsPerSec, vps: r.volPerSec, big: e.big });
      }
      const key = JSON.stringify([u.p, u.paused, u.g['tape.colorBySide'], u.g['tape.minSize']]);
      if (key !== lastKey) {
        lastKey = key;
        u.dirty = true;
      }
      // Paused (hover): only scroll / resize / settings redraw; new prints keep buffering.
      if (!u.dirty && (u.paused || e.buf.version === lastVersion)) return;
      lastVersion = e.buf.version;
      u.dirty = false;
      drawTape(c, w, h, e, {
        variant,
        inst,
        filter: ft,
        cols: u.p.cols,
        buckets: u.p.buckets,
        scroll: u.paused || !u.g['tape.autoScroll'] ? u.scroll : 0,
        paused: u.paused,
        colorBySide: u.g['tape.colorBySide'],
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // Rebuild when the instrument or the aggregation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, p.agg, p.windowMs, variant, capacity]);

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
              title={t('tape.minPrintSize')}
            >
              {t('tape.minChip', {
                n: p.filter.minSize > 0 ? formatQty(p.filter.minSize, inst.qtyPrecision) : '…',
              })}
            </Chip>
            <Chip selected={p.filter.minSize === 0} onClick={() => setFilter({ minSize: 0 })}>
              {t('tape.all')}
            </Chip>
          </>
        ) : (
          <>
            <Chip selected={p.filter.minSize > 0} onClick={() => setShowFilters((x) => !x)}>
              {t('tape.sizeGe', { n: formatQty(p.filter.minSize, inst.qtyPrecision) })}
            </Chip>
            <Chip
              selected={p.agg !== 'none'}
              onClick={() => set({ agg: p.agg === 'none' ? 'timestamp' : 'none' })}
              title={t('tape.aggregateTitle')}
            >
              {t('tape.aggregate')}
            </Chip>
          </>
        )}
        <span className="grow" />
        {paused && <span className="tape-paused">{t('tape.paused')}</span>}
        <span className="tape-speed tnum" data-testid="tape-speed">
          {t('tape.printsPerSec', { n: Math.round(meter.pps) })}
        </span>
        <IconButton
          label={p.sound ? t('tape.bigSoundOn') : t('tape.bigSoundOff')}
          active={p.sound}
          onClick={() => {
            primeAudio();
            set({ sound: !p.sound });
          }}
        >
          {p.sound ? <Bell size={13} /> : <BellOff size={13} />}
        </IconButton>
        <IconButton
          label={t('tape.filters')}
          active={showFilters}
          onClick={() => setShowFilters((x) => !x)}
        >
          <SlidersHorizontal size={13} />
        </IconButton>
      </div>
      {showFilters && (
        <div className="tape-filters" data-testid="tape-filters">
          <label>
            {t('tape.minSize')}
            <Input
              type="number"
              min={0}
              value={p.filter.minSize || ''}
              placeholder="0"
              onChange={(ev) => setFilter({ minSize: Number(ev.target.value) || 0 })}
            />
          </label>
          <label>
            {t('tape.maxSize')}
            <Input
              type="number"
              min={0}
              value={p.filter.maxSize || ''}
              placeholder={t('tape.noLimit')}
              onChange={(ev) => setFilter({ maxSize: Number(ev.target.value) || 0 })}
            />
          </label>
          <label>
            {t('tape.side')}
            <Select<SideFilter>
              small
              value={p.filter.side}
              options={[
                { value: 'all', label: t('tape.all') },
                { value: 'buy', label: t('tape.buys') },
                { value: 'sell', label: t('tape.sells') },
              ]}
              onChange={(v) => setFilter({ side: v })}
            />
          </label>
          <label>
            {t('tape.priceFrom')}
            <Input
              type="number"
              step={inst.tickSize}
              value={p.filter.minPx ?? ''}
              placeholder={t('tape.any')}
              onChange={(ev) =>
                setFilter({ minPx: ev.target.value === '' ? null : Number(ev.target.value) })
              }
            />
          </label>
          <label>
            {t('tape.priceTo')}
            <Input
              type="number"
              step={inst.tickSize}
              value={p.filter.maxPx ?? ''}
              placeholder={t('tape.any')}
              onChange={(ev) =>
                setFilter({ maxPx: ev.target.value === '' ? null : Number(ev.target.value) })
              }
            />
          </label>
          <label>
            {t('tape.aggregation')}
            <Select<AggregateMode>
              small
              value={p.agg}
              options={[
                { value: 'none', label: t('tape.aggOff') },
                { value: 'timestamp', label: t('tape.aggTimestamp') },
                { value: 'window', label: t('tape.aggWindow') },
              ]}
              onChange={(v) => set({ agg: v })}
            />
          </label>
          {p.agg === 'window' && (
            <label>
              {t('tape.windowMs')}
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
            {t('tape.bigPrint')}
            <Input
              type="number"
              min={0}
              value={p.bigSize || ''}
              placeholder={t('tape.auto', {
                n: Number.isFinite(meter.big) ? formatQty(meter.big, inst.qtyPrecision) : '—',
              })}
              onChange={(ev) => set({ bigSize: Math.max(0, Number(ev.target.value) || 0) })}
            />
          </label>
          {variant === 'smart' && (
            <>
              <Checkbox
                checked={p.buckets}
                onChange={(v) => set({ buckets: v })}
                label={t('tape.colourBySize')}
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
          <Checkbox checked={stress} onChange={setStress} label={t('tape.loadTest')} />
          <button
            className="ht-btn ht-btn--xs"
            onClick={() =>
              set({ filter: normalizeFilter({}), agg: 'timestamp', bigSize: 0, buckets: true })
            }
          >
            {t('tape.resetDefault')}
          </button>
        </div>
      )}
      <div
        ref={wrapRef}
        className="tape-canvas-wrap"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => {
          if (ui.current.g['tape.autoScroll']) ui.current.scroll = 0;
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
        {variant === 'bidask' ? t('tape.speed') : ''}
        {t('tape.footer', {
          pps: Math.round(meter.pps),
          vps: formatCompact(Number(meter.vps.toFixed(2))),
          big: Number.isFinite(meter.big) ? formatQty(meter.big, inst.qtyPrecision) : '—',
          auto: effectiveBigSize(p.bigSize, g) ? '' : ' (auto)',
          sound: effectiveSound(p.sound, g) ? t('tape.on') : t('tape.off'),
        })}
      </div>
    </div>
  );
}
