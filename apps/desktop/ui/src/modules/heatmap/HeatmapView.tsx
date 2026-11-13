import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Circle,
  Columns3,
  Gauge,
  List,
  Minus,
  MoveVertical,
  Ruler,
  Settings2,
  SlidersHorizontal,
  Square,
  Trash2,
  Type,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  TrendingUp,
} from 'lucide-react';
import {
  Button,
  Checkbox,
  ColorPicker,
  Dialog,
  Input,
  SegmentedControl,
  toast,
} from '@htflow/ui-kit';
import { ChartCore } from '@htflow/chart-engine';
import {
  bubbleSummary,
  buildSurface,
  LiquidityMapLayer,
  type HeatHit,
  type Surface,
} from '@htflow/heatmap';
import {
  findMockInstrument,
  formatCompact,
  formatPrice,
  type Instrument,
} from '@htflow/market-data';
import { type Drawing, type ToolId } from '@htflow/drawings';
import { toolLabel } from '../drawings/toolText';
import { useMarketStore, useStoreTicker } from '../../charts/useMarket';
import { usePalette } from '../../charts/palette';
import { useSettingsStore } from '../../state/settings';
import { useWindows } from '../../state/windows';
import type { ModuleViewProps } from '../registry';
import { InstrumentPicker, useFollowedInstrument } from '../smart-tape/shared';
import {
  baseSettings,
  COLUMN_WIDTHS,
  columnLabel,
  effectiveSettings,
  nextOverrides,
  readParams,
  type Camera,
  type ColumnMs,
  type HeatmapModuleSettings,
} from './model';
import { QuickSettings } from './QuickSettings';
import { FullSettings, heatFpsCap } from './FullSettings';
import { gpuPreference, heatmapRenderer } from '../../charts/settings/performance';
import { View3D } from './View3D';
import { HeatDrawings, HEATMAP_TOOLS } from './drawings';
import { StressFeed, type StressResult } from './stress';
import { registerHeatmapApi } from './api';

const TOOL_ICONS: Record<string, typeof Minus> = {
  'trend-line': TrendingUp,
  'horizontal-line': Minus,
  'vertical-line': MoveVertical,
  rectangle: Square,
  ellipse: Circle,
  'parallel-channel': Columns3,
  measure: Ruler,
  text: Type,
};

const CL = findMockInstrument('CLZ6')?.instrument;

function fmtMs(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function Tip({ hit, inst, w }: { hit: HeatHit; inst: Instrument; w: number }) {
  const left = Math.min(hit.x + 14, Math.max(0, w - 230));
  const style = { left, top: Math.max(4, hit.y - 10) };
  if (hit.kind === 'bubble') {
    const b = hit.bubble;
    const sum = bubbleSummary(b);
    return (
      <div className="hm-tip" style={style} role="tooltip" data-testid="heatmap-tooltip">
        <div className="hm-tip-head tnum">
          <b>{formatPrice(Math.round(b.px), inst)}</b>
          <span className="muted">{fmtMs(b.t)}</span>
        </div>
        <div className="hm-tip-row tnum">
          Vol: {formatCompact(sum.vol)} <span className="hm-tip-side">{sum.side}</span>
        </div>
        <div className="hm-tip-row tnum">
          <span className="hm-dot hm-dot--up" /> Buy {formatCompact(sum.buy)} ({sum.buyPct}%)
          <span className="hm-dot hm-dot--down" /> Sell {formatCompact(sum.sell)} ({sum.sellPct}%)
        </div>
        <div className="hm-tip-row tnum">Trades: {sum.trades}</div>
      </div>
    );
  }
  return (
    <div className="hm-tip" style={style} role="tooltip" data-testid="heatmap-tooltip">
      <div className="hm-tip-head tnum">
        <b>{formatPrice(hit.px, inst)}</b>
        <span className="muted">{fmtMs(hit.t)}</span>
      </div>
      <div className="hm-tip-row tnum">
        Resting: {hit.qty > 0 ? formatCompact(Math.round(hit.qty * 1000) / 1000) : '—'}
        {hit.side && <span className="hm-tip-side">{hit.side === 'bid' ? 'BID' : 'ASK'}</span>}
      </div>
      {hit.spoof && (
        <div className="hm-tip-row hm-tip-warn tnum">
          Pulled {formatCompact(hit.spoof.size)} after{' '}
          {((hit.spoof.t1 - hit.spoof.t0) / 1000).toFixed(1)} s (traded{' '}
          {formatCompact(hit.spoof.traded)})
        </div>
      )}
      {hit.iceberg && (
        <div className="hm-tip-row hm-tip-info tnum">
          Iceberg: traded {formatCompact(hit.iceberg.traded)} vs shown{' '}
          {formatCompact(hit.iceberg.shown)} · {hit.iceberg.refills} refills
        </div>
      )}
    </div>
  );
}

/** P11 standalone Heatmap window (ribbon → Heatmap). */
export function HeatmapView({ windowId, state, setParams }: ModuleViewProps) {
  const params = useMemo(() => readParams(state.params), [state.params]);
  const values = useSettingsStore((x) => x.values);
  const base = useMemo(() => baseSettings(values), [values]);
  const s = useMemo(() => effectiveSettings(params, base), [params, base]);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const patch = useCallback(
    (p: Partial<HeatmapModuleSettings>) =>
      setParamsRef.current({ overrides: nextOverrides(paramsRef.current.overrides, p, base) }),
    [base],
  );

  const instrumentId = useFollowedInstrument(params.instrumentId);
  const store = useMarketStore(instrumentId);
  useStoreTicker(store, 2);
  const palette = usePalette();
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const coreRef = useRef<ChartCore | null>(null);
  const layerRef = useRef<LiquidityMapLayer | null>(null);
  const drawRef = useRef<HeatDrawings | null>(null);
  const [qs, setQs] = useState(false);
  const [full, setFull] = useState(false);
  const [stress, setStress] = useState<StressFeed | null>(null);
  const [stressResult, setStressResult] = useState<StressResult | null>(null);
  const [tip, setTip] = useState<HeatHit | null>(null);
  const [textEdit, setTextEdit] = useState<Drawing | null>(null);
  const [drawPanel, setDrawPanel] = useState<'objects' | 'settings' | null>(null);
  const [, setDrawVersion] = useState(0);
  const [used3d, setUsed3d] = useState<string>('');
  const sRef = useRef(s);
  sRef.current = s;

  const fpsMode = values['common.heatmapFpsMode'];
  const fpsCap = values['common.heatmapFpsCap'];
  // ---------------------------------------------------------------- build
  useEffect(() => {
    const el = host.current;
    if (!el || (!stress && !store.ready)) return;
    const inst = stress && CL ? CL : store.instrument;
    const src = stress
      ? { depth: () => stress.depth, trades: stress.tradesBetween, book: () => stress.book }
      : {
          depth: () => store.depth,
          trades: (a: number, b: number) => store.tradesBetween(a, b),
          book: () => store.book,
        };
    const cur = sRef.current;
    const core = new ChartCore(el, inst, palette, {
      priceAxis: cur.priceAxis,
      timeAxis: cur.timeAxis,
      showGrid: cur.grid,
      priceAxisWidth: cur.priceAxisWidth,
      rightMargin: 30,
      minSlotWidth: 0.5,
    });
    core.slotWidth = 2.5;
    core.rightOffset = 30;
    const layer = new LiquidityMapLayer(src.depth, src.trades, src.book, cur);
    layer.stride = Math.max(1, Math.round(paramsRef.current.columnMs / 250));
    core.setSource(layer.source());
    const dr = new HeatDrawings(
      core,
      paramsRef.current.drawings,
      (doc) => setParamsRef.current({ drawings: doc }),
      () => paramsRef.current.columnMs,
      (d) => setTextEdit(d),
    );
    const unDraw = dr.subscribe(() => setDrawVersion((x) => x + 1));
    const probe = {
      id: 'stress-probe',
      draw: () => stress?.frame(performance.now(), layer.stats.heatMs, layer.stats.drawMs),
    };
    core.setLayers([layer, dr.layer, probe]);
    coreRef.current = core;
    layerRef.current = layer;
    drawRef.current = dr;

    // Invalidation: every store update (auto) or capped (Settings → Common → FPS cap).
    const cap = heatFpsCap();
    let pending = false;
    const unsub = stress
      ? () => {}
      : store.subscribe(() => {
          if (cap > 0) pending = true;
          else core.invalidate();
        });
    const timer =
      cap > 0
        ? setInterval(() => {
            if (pending) {
              pending = false;
              core.invalidate();
            }
          }, 1000 / cap)
        : null;
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (stress) {
        const running = stress.tick(now);
        core.invalidate();
        if (!running && !stress.done) {
          const r = stress.finish();
          setStressResult(r);
          toast(
            r.passed ? 'success' : 'warning',
            `Heatmap stress test: ${r.fps.toFixed(0)} fps`,
            `${r.columns} columns at ${stress.speed}× · heat ${r.heatMs.toFixed(1)} ms · draw ${r.drawMs.toFixed(1)} ms · p95 frame ${r.p95FrameMs.toFixed(1)} ms`,
          );
          setStress(null);
        }
      } else if (layer.animating) core.invalidate();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      unsub();
      unDraw();
      dr.dispose();
      core.destroy();
      coreRef.current = null;
      layerRef.current = null;
      drawRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, store.ready, params.columnMs, stress, fpsMode, fpsCap]);

  // Settings apply in place.
  useEffect(() => {
    const core = coreRef.current;
    const layer = layerRef.current;
    if (!core || !layer) return;
    layer.settings = { ...s };
    core.options.priceAxis = s.priceAxis;
    core.options.timeAxis = s.timeAxis;
    core.options.showGrid = s.grid;
    core.options.priceAxisWidth = s.priceAxisWidth;
    core.invalidate();
  }, [s, stress, store.ready]);
  useEffect(() => coreRef.current?.setPalette(palette), [palette]);

  // ---------------------------------------------------------------- 3D surface
  const surfCache = useRef<{
    key: string;
    v: { s: Surface; lut: Uint8ClampedArray; version: number };
  } | null>(null);
  const surface = useCallback(() => {
    const core = coreRef.current;
    const layer = layerRef.current;
    const v = core?.view;
    if (!core || !layer || !v || v.i1 < v.i0) return null;
    const cur = sRef.current;
    const last = layer.col(v.i1);
    const key = `${v.i0}:${v.i1}:${Math.round(v.priceMin)}:${Math.round(v.priceMax)}:${last?.t}:${JSON.stringify(cur)}`;
    if (surfCache.current?.key === key) return surfCache.current.v;
    const lo = Math.floor(v.priceMin);
    const hi = Math.ceil(v.priceMax);
    const surf = buildSurface((i) => layer.col(i), v.i0, v.i1, lo, hi, {
      maxCols: cur.surfaceCols,
      maxRows: 120,
      mode: cur.normalize,
      global: layer.globalCut(v.i0, v.i1, [lo, hi]),
      lowerPct: cur.cutoffLower,
      upperPct: cur.cutoffUpper,
      scale: cur.scale,
      minSize: cur.minSize,
    });
    const val = {
      s: surf,
      lut: layer.colorLut(),
      version: (surfCache.current?.v.version ?? 0) + 1,
    };
    surfCache.current = { key, v: val };
    return val;
  }, []);

  // ---------------------------------------------------------------- tooltip
  const tipRaf = useRef(0);
  const onMove = (e: React.PointerEvent) => {
    if (params.mode3d || drawRef.current?.tool) {
      if (tip) setTip(null);
      return;
    }
    const r = host.current?.getBoundingClientRect();
    if (!r) return;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    cancelAnimationFrame(tipRaf.current);
    tipRaf.current = requestAnimationFrame(() => {
      const v = coreRef.current?.view;
      const layer = layerRef.current;
      setTip(v && layer ? layer.hitTest(v, x, y) : null);
    });
  };

  // ---------------------------------------------------------------- actions
  const set3d = useCallback((v: boolean) => setParamsRef.current({ mode3d: v }), []);
  const setColumn = useCallback((ms: ColumnMs) => setParamsRef.current({ columnMs: ms }), []);
  const setCamera = useCallback((c: Camera) => setParamsRef.current({ camera: c }), []);
  const saveGradient = useCallback((name: string) => {
    const stops = sRef.current.gradient === 'custom' ? sRef.current.customStops : null;
    if (!stops) return;
    setParamsRef.current({
      savedGradients: { ...paramsRef.current.savedGradients, [name]: stops },
    });
    toast('success', `Gradient “${name}” saved`);
  }, []);
  const startStress = useCallback(() => {
    setStressResult(null);
    setStress(new StressFeed(12, 10));
  }, []);
  const snapshot = useCallback(() => {
    const canvas =
      (wrap.current?.querySelector('.hm-3d canvas') as HTMLCanvasElement | null) ??
      coreRef.current?.canvas;
    canvas?.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `htflow-heatmap-${store.instrument.symbol}.png`;
      a.click();
    });
  }, [store]);

  useEffect(
    () =>
      registerHeatmapApi(windowId, {
        patch: (p) => patch(p),
        settings: () => sRef.current,
        toggle3d: () => set3d(!paramsRef.current.mode3d),
        quickSettings: () => setQs((x) => !x),
        fullSettings: () => setFull(true),
        column: setColumn,
        stress: startStress,
        resetView: () => coreRef.current?.reset(),
        resetSettings: () => setParamsRef.current({ overrides: {} }),
        snapshot,
        tool: (t) => drawRef.current?.setTool(t),
        objects: () => setDrawPanel((x) => (x === 'objects' ? null : 'objects')),
      }),
    [windowId, patch, set3d, setColumn, startStress, snapshot],
  );

  const dr = drawRef.current;
  const inst = stress && CL ? CL : store.instrument;
  const status = store.status.state;
  const cols = layerRef.current?.source().count() ?? 0;

  return (
    <div
      className="hm-window"
      ref={wrap}
      data-testid="heatmap-window"
      data-gradient={s.gradient}
      data-bubbles={s.bubbles ? 'on' : 'off'}
      data-bubble-style={s.bubbleStyle}
      data-mode3d={params.mode3d ? 'on' : 'off'}
      data-normalize={s.normalize}
      onMouseDown={() => useWindows.getState().setActive(windowId)}
    >
      <div className="hm-toolbar">
        <InstrumentPicker
          fixed={params.instrumentId}
          current={instrumentId}
          onChange={(id) => setParams({ instrumentId: id })}
        />
        <div className="hm-qs-anchor">
          <button
            type="button"
            className="ht-chip"
            aria-pressed={qs}
            aria-haspopup="dialog"
            data-hm-qs-trigger
            data-testid="heatmap-settings-button"
            onClick={() => setQs((x) => !x)}
          >
            <SlidersHorizontal size={12} /> Settings ▾
          </button>
          {qs && (
            <QuickSettings
              s={s}
              onPatch={patch}
              mode3d={params.mode3d}
              onMode3d={set3d}
              savedGradients={params.savedGradients}
              onSaveGradient={saveGradient}
              onOpenFull={() => {
                setQs(false);
                setFull(true);
              }}
              onClose={() => setQs(false)}
            />
          )}
        </div>
        <SegmentedControl
          aria-label="Column width"
          value={String(params.columnMs)}
          options={COLUMN_WIDTHS.map((ms) => ({ value: String(ms), label: columnLabel(ms) }))}
          onChange={(v) => setColumn(Number(v) as ColumnMs)}
        />
        <span className={`hm-badge ${stress ? 'hm-badge--warn' : ''}`}>
          {stress
            ? `Stress ${stress.speed}×`
            : status === 'replay'
              ? 'Replay'
              : status === 'live'
                ? 'Live'
                : status}
        </span>
        <div className="grow" />
        <button
          type="button"
          className="ht-chip"
          aria-pressed={params.mode3d}
          data-testid="heatmap-3d-toggle"
          onClick={() => set3d(!params.mode3d)}
          title="3D mode (time × price × size)"
        >
          <Box size={12} /> {params.mode3d ? '3D on' : '3D off'}
        </button>
        <button
          type="button"
          className="ht-chip ht-chip--ghost"
          onClick={() => setFull(true)}
          title="Open full settings"
          aria-label="Open full settings"
        >
          <Settings2 size={12} />
        </button>
      </div>
      <div className="hm-main">
        <div
          className="hm-tools"
          role="toolbar"
          aria-label="Drawing tools"
          aria-orientation="vertical"
        >
          {HEATMAP_TOOLS.map((t) => {
            const Icon = TOOL_ICONS[t.id] ?? Minus;
            return (
              <button
                key={t.id}
                type="button"
                className="hm-tool"
                aria-label={toolLabel(t.id)}
                title={toolLabel(t.id)}
                aria-pressed={dr?.tool === t.id}
                onClick={() => dr?.setTool(t.id)}
              >
                <Icon size={15} />
              </button>
            );
          })}
          <div className="hm-tools-sep" />
          <button
            type="button"
            className="hm-tool"
            aria-label="Objects list"
            title="Objects list"
            aria-pressed={drawPanel === 'objects'}
            onClick={() => setDrawPanel((x) => (x === 'objects' ? null : 'objects'))}
          >
            <List size={15} />
          </button>
          <button
            type="button"
            className="hm-tool"
            aria-label="Drawing settings"
            title="Drawing settings"
            aria-pressed={drawPanel === 'settings'}
            onClick={() => setDrawPanel((x) => (x === 'settings' ? null : 'settings'))}
          >
            <Gauge size={15} />
          </button>
          {drawPanel && dr && (
            <DrawPanel kind={drawPanel} dr={dr} onClose={() => setDrawPanel(null)} />
          )}
        </div>
        <div
          className="hm-host-wrap"
          data-testid="chart-heatmap"
          onPointerMove={onMove}
          onPointerLeave={() => setTip(null)}
        >
          {!stress && !store.ready && (
            <div className="chart-loading">
              {store.error ?? `Loading ${store.instrument.symbol} depth…`}
            </div>
          )}
          <div ref={host} className="hm-host" />
          {tip && !params.mode3d && (
            <Tip hit={tip} inst={inst} w={host.current?.clientWidth ?? 800} />
          )}
          {params.mode3d && (
            <View3D
              surface={surface}
              camera={params.camera}
              onCamera={setCamera}
              height={s.surfaceHeight}
              renderer={heatmapRenderer(s.renderer3d, values)}
              powerPreference={gpuPreference(values)}
              background={palette.chartBg}
              onRenderer={setUsed3d}
            />
          )}
          {stressResult && (
            <div className="hm-stress" data-testid="heatmap-stress-result">
              <b>
                {stressResult.passed ? '✓' : '✗'} {stressResult.fps.toFixed(0)} fps
              </b>{' '}
              · {stressResult.columns} columns · heat {stressResult.heatMs.toFixed(1)} ms · draw{' '}
              {stressResult.drawMs.toFixed(1)} ms · p95 frame {stressResult.p95FrameMs.toFixed(1)}{' '}
              ms
              <button type="button" className="hm-link" onClick={() => setStressResult(null)}>
                Close
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="hm-status">
        <span className="tnum">
          Brightness {s.brightness} · Cut-off {s.cutoffUpper}/{s.cutoffLower} · {s.scale} ·{' '}
          {s.normalize === 'column' ? 'per column' : `global (${s.scope})`} · {cols} columns of{' '}
          {columnLabel(params.columnMs)}
          {s.historyMinutes > 0 ? ` · history ${s.historyMinutes} min` : ''}
          {params.mode3d && used3d ? ` · 3D ${used3d === 'webgl' ? 'three.js' : 'Canvas 2D'}` : ''}
        </span>
        <div className="grow" />
        <button
          type="button"
          className="ht-chip ht-chip--ghost"
          onClick={startStress}
          disabled={!!stress}
          data-testid="heatmap-stress"
          title="Stream a CL-like book at 10× and measure the frame rate"
        >
          {stress ? 'Stress test running…' : 'Stress test'}
        </button>
        <button
          type="button"
          className="ht-chip ht-chip--ghost"
          onClick={() => coreRef.current?.reset()}
        >
          ◂▸ Latest
        </button>
      </div>
      <FullSettings
        open={full}
        onOpenChange={setFull}
        s={s}
        onPatch={patch}
        onReset={() => setParams({ overrides: {} })}
        columnMs={params.columnMs}
        onColumnMs={setColumn}
        palette={palette}
        savedGradients={params.savedGradients}
        onSaveGradient={saveGradient}
      />
      <TextDialog
        d={textEdit}
        onClose={() => setTextEdit(null)}
        onSave={(id, text) =>
          drawRef.current?.update(id, (d) => ({ ...d, style: { ...d.style, text } }))
        }
      />
    </div>
  );
}

function TextDialog({
  d,
  onClose,
  onSave,
}: {
  d: Drawing | null;
  onClose: () => void;
  onSave: (id: string, text: string) => void;
}) {
  const [text, setText] = useState('');
  useEffect(() => setText(d?.style.text ?? 'Text'), [d]);
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()} title="Text" width={360}>
      <form
        className="col gap12"
        onSubmit={(e) => {
          e.preventDefault();
          if (d) onSave(d.id, text.slice(0, 500));
          onClose();
        }}
      >
        <Input aria-label="Text" value={text} autoFocus onChange={(e) => setText(e.target.value)} />
        <Button variant="primary" type="submit">
          Save
        </Button>
      </form>
    </Dialog>
  );
}

function DrawPanel({
  kind,
  dr,
  onClose,
}: {
  kind: 'objects' | 'settings';
  dr: HeatDrawings;
  onClose: () => void;
}) {
  const list = dr.list();
  const sel = list.find((d) => d.id === dr.selected) ?? null;
  return (
    <div
      className="hm-draw-panel"
      role="dialog"
      aria-label={kind === 'objects' ? 'Objects list' : 'Drawing settings'}
    >
      <header className="hm-draw-head">
        <b>{kind === 'objects' ? 'Objects list' : 'Drawing settings'}</b>
        <button type="button" className="hm-link" onClick={onClose}>
          Close
        </button>
      </header>
      {kind === 'objects' ? (
        list.length === 0 ? (
          <p className="muted hm-note">No drawings yet. Pick a tool on the left.</p>
        ) : (
          <ul className="hm-objects">
            {list.map((d) => (
              <li key={d.id} data-selected={d.id === dr.selected || undefined}>
                <button
                  type="button"
                  className="hm-obj-name"
                  onClick={() => dr.ctrl.host.select(d.id)}
                >
                  {toolLabel(d.type)}
                </button>
                <button
                  type="button"
                  className="hm-icon"
                  aria-label={d.hidden ? 'Show' : 'Hide'}
                  onClick={() => dr.update(d.id, (x) => ({ ...x, hidden: !x.hidden }))}
                >
                  {d.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button
                  type="button"
                  className="hm-icon"
                  aria-label={d.locked ? 'Unlock' : 'Lock'}
                  onClick={() => dr.update(d.id, (x) => ({ ...x, locked: !x.locked }))}
                >
                  {d.locked ? <Lock size={12} /> : <Unlock size={12} />}
                </button>
                <button
                  type="button"
                  className="hm-icon"
                  aria-label="Delete"
                  onClick={() => dr.ctrl.remove(d.id)}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="col gap8">
          <Checkbox
            checked={dr.prefs.keep}
            onChange={(v) => dr.setPrefs({ keep: v })}
            label="Keep drawing"
          />
          <Checkbox
            checked={dr.prefs.magnet}
            onChange={(v) => dr.setPrefs({ magnet: v })}
            label="Magnet"
          />
          <Checkbox
            checked={dr.prefs.snapTicks}
            onChange={(v) => dr.setPrefs({ snapTicks: v })}
            label="Snap to ticks"
          />
          {sel ? (
            <>
              <div className="hm-row">
                <span className="hm-row-label">Colour</span>
                <ColorPicker
                  label="Drawing colour"
                  value={sel.style.color}
                  alpha={false}
                  onChange={(c) =>
                    dr.update(sel.id, (x) => ({ ...x, style: { ...x.style, color: c } }))
                  }
                />
              </div>
              <div className="hm-row">
                <span className="hm-row-label">Width</span>
                <SegmentedControl
                  aria-label="Line width"
                  value={String(sel.style.width)}
                  options={['1', '2', '3', '4'].map((w) => ({ value: w, label: w }))}
                  onChange={(w) =>
                    dr.update(sel.id, (x) => ({ ...x, style: { ...x.style, width: Number(w) } }))
                  }
                />
              </div>
            </>
          ) : (
            <p className="muted hm-note">Select a drawing to edit its colour and width.</p>
          )}
          <Button size="sm" onClick={() => dr.ctrl.removeAll()}>
            Delete all drawings
          </Button>
        </div>
      )}
    </div>
  );
}

export type { ToolId };
