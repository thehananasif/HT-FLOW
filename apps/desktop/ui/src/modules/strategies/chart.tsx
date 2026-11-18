import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import type { RawInputs } from '@htflow/indicator-sdk';
import type { Bar, BarSpec } from '@htflow/market-data';
import { datasetFromHistory } from '@htflow/replay';
import {
  DEFAULT_BACKTEST,
  STRATEGIES,
  runBacktest,
  strategyById,
  type BacktestResult,
} from '@htflow/strategy';
import { netOf, type Fill, type RoundTrip } from '@htflow/trading';
import {
  Button,
  Checkbox,
  Chip,
  ColorSwatch,
  Dialog,
  NumberInput,
  Select,
  toast,
} from '@htflow/ui-kit';
import type { ChartWindowState, WindowState } from '@htflow/workspace';
import { registerChartExtension, registerHeaderItem } from '../../charts/extensions';
import { useWindows } from '../../state/windows';
import { paper } from '../../state/market';
import { journalStore } from '../journal/store';
import { liveRuns, liveTrips } from './live';
import { InputsForm, money, openModule, toStrategyInstrument, validColor } from './shared';

export const EXT_ID = 'strategy';

export type SnapshotMode = 'off' | 'strategy' | 'all';

/** Per-chart strategy settings, persisted in ChartWindowState.ext.strategy. */
export interface StrategyExt {
  v: 1;
  strategyId: string | null;
  inputs: RawInputs;
  /** Run live on the paper account. */
  live: boolean;
  /** Show the backtest of the loaded history. */
  history: boolean;
  /** P&L label per trade. */
  pnl: boolean;
  /** Journal snapshots at entry and exit. */
  snapshots: SnapshotMode;
  style: { long: string; short: string; win: string; loss: string; size: number; opacity: number };
}

export const DEFAULT_EXT: StrategyExt = {
  v: 1,
  strategyId: null,
  inputs: {},
  live: false,
  history: true,
  pnl: true,
  snapshots: 'strategy',
  style: {
    long: '#20C77A',
    short: '#F04A5D',
    win: '#20C77A',
    loss: '#F04A5D',
    size: 5,
    opacity: 0.55,
  },
};

export function normalizeStrategyExt(raw: unknown): StrategyExt {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StrategyExt>;
  const s = (r.style ?? {}) as Partial<StrategyExt['style']>;
  const d = DEFAULT_EXT.style;
  const num = (v: unknown, def: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  return {
    v: 1,
    strategyId:
      typeof r.strategyId === 'string' && strategyById(r.strategyId) ? r.strategyId : null,
    inputs: r.inputs && typeof r.inputs === 'object' ? r.inputs : {},
    live: r.live === true,
    history: r.history !== false,
    pnl: r.pnl !== false,
    snapshots: r.snapshots === 'off' || r.snapshots === 'all' ? r.snapshots : 'strategy',
    style: {
      long: validColor(s.long, d.long),
      short: validColor(s.short, d.short),
      win: validColor(s.win, d.win),
      loss: validColor(s.loss, d.loss),
      size: num(s.size, d.size, 2, 14),
      opacity: num(s.opacity, d.opacity, 0.1, 1),
    },
  };
}

export function readStrategyExt(windowId: string): StrategyExt {
  const w = useWindows.getState().windows[windowId];
  return normalizeStrategyExt(w?.kind === 'chart' ? w.ext?.[EXT_ID] : undefined);
}

export function writeStrategyExt(windowId: string, patch: Partial<StrategyExt>): void {
  const cur = useWindows.getState().windows[windowId];
  if (cur?.kind !== 'chart') return;
  const next = { ...readStrategyExt(windowId), ...patch };
  useWindows
    .getState()
    .patch(windowId, { ext: { ...(cur.ext ?? {}), [EXT_ID]: next } } as Partial<WindowState>);
}

export const useStrategyDialog = create<{ windowId: string | null; open(id: string | null): void }>(
  (set) => ({ windowId: null, open: (windowId) => set({ windowId }) }),
);

/** Backtest of each chart's loaded history (for the markers), by window id. */
const history = new Map<string, { key: string; result: BacktestResult | null }>();
const historyListeners = new Set<() => void>();

function computeHistory(
  windowId: string,
  ext: StrategyExt,
  store: Parameters<typeof datasetFromHistory>[0] & { instrument: { id: string } },
  bars: BarSpec,
): BacktestResult | null {
  if (!ext.strategyId || !ext.history) return null;
  const def = strategyById(ext.strategyId);
  if (!def || store.trades.length < 2) return null;
  const key = JSON.stringify([ext.strategyId, ext.inputs, bars, store.trades.length >> 12]);
  const hit = history.get(windowId);
  if (hit?.key === key) return hit.result;
  const from = store.trades[0]!.ts;
  const to = store.trades[store.trades.length - 1]!.ts;
  let result: BacktestResult | null = null;
  try {
    result = runBacktest(def, ext.inputs, datasetFromHistory(store, from, to), {
      ...DEFAULT_BACKTEST,
      instrument: toStrategyInstrument(store.instrument),
      bars,
    });
  } catch (e) {
    console.warn('chart strategy backtest failed', e);
  }
  history.set(windowId, { key, result });
  for (const l of historyListeners) l();
  return result;
}

function barIndex(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  if (hi < 0 || t < bars[0]!.t) return -1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (bars[m]!.t <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}

type Marked = Pick<RoundTrip, 'side' | 'entryPx' | 'exitPx' | 'entryTs' | 'exitTs'> & {
  net: number;
};

/** Entry / exit markers with a connector and the trade's P&L at the exit bar. */
class StrategyMarkersLayer implements ChartLayer {
  readonly id = 'strategy-markers';
  constructor(
    private windowId: string,
    private bars: () => readonly Bar[],
    private liveTag: () => string | null,
  ) {}

  draw(v: ChartView): void {
    const ext = readStrategyExt(this.windowId);
    if (!ext.strategyId) return;
    const bars = this.bars();
    if (!bars.length) return;
    const hist: Marked[] = ext.history
      ? (history.get(this.windowId)?.result?.trades ?? []).map((t) => ({ ...t }))
      : [];
    const tag = this.liveTag();
    const live: Marked[] = tag ? liveTrips(tag).map((t) => ({ ...t, net: netOf(t) })) : [];
    const { ctx } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    this.drawSet(v, bars, hist, ext, ext.style.opacity);
    this.drawSet(v, bars, live, ext, 1);
    ctx.restore();
  }

  private drawSet(v: ChartView, bars: readonly Bar[], list: Marked[], ext: StrategyExt, a: number) {
    const { ctx } = v;
    const s = ext.style;
    const r = s.size;
    ctx.globalAlpha = a;
    ctx.font = v.font(10, 600, true);
    for (const t of list) {
      const ei = barIndex(bars, t.entryTs);
      const xi = barIndex(bars, t.exitTs);
      if (xi < v.i0 - 1 || ei > v.i1 + 1 || ei < 0) continue;
      const x1 = v.xOf(ei);
      const y1 = v.yOf(t.entryPx);
      const x2 = v.xOf(xi);
      const y2 = v.yOf(t.exitPx);
      const win = t.net >= 0;
      // Connector.
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = win ? s.win : s.loss;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      // Entry: triangle pointing in the trade direction.
      const up = t.side === 'long';
      ctx.fillStyle = up ? s.long : s.short;
      ctx.beginPath();
      if (up) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - r, y1 + r * 1.6);
        ctx.lineTo(x1 + r, y1 + r * 1.6);
      } else {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - r, y1 - r * 1.6);
        ctx.lineTo(x1 + r, y1 - r * 1.6);
      }
      ctx.closePath();
      ctx.fill();
      // Exit: ring.
      ctx.strokeStyle = win ? s.win : s.loss;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x2, y2, r * 0.8, 0, Math.PI * 2);
      ctx.stroke();
      if (ext.pnl) {
        const label = (t.net > 0 ? '+' : '') + money(t.net);
        ctx.fillStyle = win ? s.win : s.loss;
        ctx.textAlign = 'center';
        ctx.textBaseline = up === win ? 'top' : 'bottom';
        ctx.fillText(label, x2, up === win ? y2 + r + 3 : y2 - r - 3);
      }
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ journal snapshots

/** Captures a chart's canvases (side by side for split charts) as a JPEG data URL. */
function capture(canvases: HTMLCanvasElement[]): string | null {
  const w = canvases.reduce((a, c) => a + c.width, 0);
  const h = Math.max(0, ...canvases.map((c) => c.height));
  if (!w || !h) return null;
  const scale = Math.min(1, 1200 / w);
  const out = document.createElement('canvas');
  out.width = Math.round(w * scale);
  out.height = Math.round(h * scale);
  const g = out.getContext('2d');
  if (!g) return null;
  let x = 0;
  for (const c of canvases) {
    g.drawImage(c, x * scale, 0, c.width * scale, c.height * scale);
    x += c.width;
  }
  try {
    return out.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}

/** Snapshots waiting for their journal trip: by entry and exit order id. */
const pendingEntry = new Map<string, string>();
const pendingExit = new Map<string, string>();

function attachPending(): void {
  if (!pendingEntry.size && !pendingExit.size) return;
  for (const t of journalStore.trips()) {
    const add: string[] = [];
    const e = t.entryOrderId && pendingEntry.get(t.entryOrderId);
    const x = t.exitOrderId && pendingExit.get(t.exitOrderId);
    if (!e && !x) continue;
    if (e) add.push(e);
    if (x) add.push(x);
    if (x) pendingExit.delete(t.exitOrderId!);
    const meta = journalStore.meta(t.id);
    const fresh = add.filter((a) => !meta.attachments.includes(a));
    if (fresh.length) journalStore.setMeta(t.id, { attachments: [...meta.attachments, ...fresh] });
  }
  // Entry snapshots stay until their order's last trip closed; cap memory.
  while (pendingEntry.size > 50) pendingEntry.delete(pendingEntry.keys().next().value!);
}
journalStore.subscribe(attachPending);

registerChartExtension({
  id: EXT_ID,
  layers(ctx) {
    return [
      new StrategyMarkersLayer(
        ctx.windowId,
        () => ctx.series()?.bars ?? [],
        () => liveRuns.get(ctx.windowId)?.tag ?? null,
      ),
    ];
  },
  attach(ctx) {
    if (!ctx.series()) return;
    const store = ctx.store;
    const spec = ctx.state().timeframe as BarSpec;
    let last = '';
    const apply = () => {
      const ext = readStrategyExt(ctx.windowId);
      const sig = JSON.stringify([ext.strategyId, ext.inputs, ext.live]);
      computeHistory(ctx.windowId, ext, store, spec);
      if (sig !== last) {
        last = sig;
        const run = liveRuns.get(ctx.windowId);
        if (ext.strategyId && ext.live) {
          liveRuns.start(ctx.windowId, store, ext.strategyId, ext.inputs, spec);
        } else if (run) liveRuns.stop(ctx.windowId, false);
      }
      ctx.cores.forEach((c) => c.invalidate());
    };
    apply();
    const unWin = useWindows.subscribe(apply);
    // Recompute the history backtest as live data accumulates (every ~4096 trades).
    const unTrades = store.onTrades(() => {
      const ext = readStrategyExt(ctx.windowId);
      if (ext.strategyId && ext.history) computeHistory(ctx.windowId, ext, store, spec);
    });
    const unPaper = paper.subscribe(() => ctx.cores.forEach((c) => c.invalidate()));
    // Journal snapshots at entry and exit.
    const hook = (f: Fill) => {
      if (f.instrumentId !== store.instrument.id) return;
      const ext = readStrategyExt(ctx.windowId);
      const tag = liveRuns.get(ctx.windowId)?.tag;
      const ours =
        ext.snapshots === 'all' || (ext.snapshots === 'strategy' && !!tag && f.tag === tag);
      if (!ours) return;
      const url = capture(ctx.cores.map((c) => c.snapshotCanvas()));
      if (!url) return;
      if (f.realized !== 0) pendingExit.set(f.orderId, url);
      else pendingEntry.set(f.orderId, url);
    };
    paper.postFillHooks.push(hook);
    return () => {
      unWin();
      unTrades();
      unPaper();
      const i = paper.postFillHooks.indexOf(hook);
      if (i >= 0) paper.postFillHooks.splice(i, 1);
      liveRuns.stop(ctx.windowId, false);
      history.delete(ctx.windowId);
    };
  },
  menu(ctx) {
    const ext = readStrategyExt(ctx.windowId);
    return [
      {
        id: 'strategy',
        label: ext.strategyId ? 'Strategy settings…' : 'Attach strategy…',
        onSelect: () => useStrategyDialog.getState().open(ctx.windowId),
      },
      ...(ext.strategyId
        ? [
            {
              id: 'strategy-live',
              label: ext.live ? 'Stop live strategy' : 'Run strategy live on paper',
              onSelect: () => writeStrategyExt(ctx.windowId, { live: !ext.live }),
            },
          ]
        : []),
    ];
  },
  Overlay: function StrategyOverlay({ windowId, state }) {
    const open = useStrategyDialog((s) => s.windowId === windowId);
    const ext = normalizeStrategyExt(state.ext?.[EXT_ID]);
    const n = history.get(windowId)?.result?.trades.length;
    return (
      <>
        <span className="stg-sr" data-testid="chart-strategy-state" data-live={ext.live}>
          {ext.strategyId ?? 'none'}
          {n !== undefined ? ` ${n} trades` : ''}
        </span>
        {open && <StrategyDialog windowId={windowId} />}
      </>
    );
  },
});

function useLiveVersion(): void {
  const [, set] = useState(0);
  useEffect(() => liveRuns.subscribe(() => set((x) => x + 1)), []);
  useEffect(() => {
    const fn = () => set((x) => x + 1);
    historyListeners.add(fn);
    return () => void historyListeners.delete(fn);
  }, []);
}

/** Status chip in every chart header: strategy name and Off / Backtest / Live. */
function HeaderChip({ windowId, state }: { windowId: string; state: ChartWindowState }) {
  useLiveVersion();
  const ext = normalizeStrategyExt(state.ext?.[EXT_ID]);
  const def = ext.strategyId ? strategyById(ext.strategyId) : undefined;
  const run = liveRuns.get(windowId);
  const status = !def ? 'off' : run ? (run.status === 'error' ? 'error' : 'live') : 'backtest';
  return (
    <Chip
      variant="ghost"
      data-testid="strategy-chip"
      data-status={status}
      title={def ? `${def.name} — ${status}` : 'Attach a strategy'}
      onClick={() => useStrategyDialog.getState().open(windowId)}
    >
      <span className="stg-chip-dot" data-status={status} />
      {def ? def.name.split(' ').slice(0, 2).join(' ') : 'Strategy'}
      {def && (
        <span className="stg-chip-state">
          {status === 'live' ? 'Live' : status === 'error' ? 'Error' : 'Test'}
        </span>
      )}
    </Chip>
  );
}
registerHeaderItem({ id: EXT_ID, order: 30, Component: HeaderChip });

function StrategyDialog({ windowId }: { windowId: string }) {
  useLiveVersion();
  const w = useWindows((s) => s.windows[windowId]);
  const ext = normalizeStrategyExt(w?.kind === 'chart' ? w.ext?.[EXT_ID] : undefined);
  const set = (p: Partial<StrategyExt>) => writeStrategyExt(windowId, p);
  const def = ext.strategyId ? strategyById(ext.strategyId) : undefined;
  const res = history.get(windowId)?.result;
  const run = liveRuns.get(windowId);
  const close = () => useStrategyDialog.getState().open(null);
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title="Chart strategy" width={520}>
      <div className="stg-dialog" data-testid="chart-strategy-dialog">
        <label className="stg-input-row">
          <span>Strategy</span>
          <Select
            small
            aria-label="Strategy"
            value={ext.strategyId ?? ''}
            options={[
              { value: '', label: '— none —' },
              ...STRATEGIES.map((s) => ({ value: s.id, label: s.name })),
            ]}
            onChange={(v) => set({ strategyId: v || null, inputs: {}, live: false })}
          />
        </label>
        {def && (
          <>
            <p className="stg-muted">{def.description}</p>
            <InputsForm
              defs={def.inputs}
              values={ext.inputs}
              onChange={(inputs) => set({ inputs })}
            />
            <div className="stg-dialog-row">
              <Checkbox
                checked={ext.history}
                onChange={(history) => set({ history })}
                label="Backtest loaded history"
              />
              <Checkbox checked={ext.pnl} onChange={(pnl) => set({ pnl })} label="P&L per trade" />
            </div>
            <label className="stg-input-row">
              <span>Journal snapshots</span>
              <Select
                small
                aria-label="Journal snapshots"
                value={ext.snapshots}
                options={[
                  { value: 'strategy', label: 'Strategy trades' },
                  { value: 'all', label: 'All trades on this chart' },
                  { value: 'off', label: 'Off' },
                ]}
                onChange={(snapshots) => set({ snapshots })}
              />
            </label>
            <div className="stg-dialog-row stg-colors">
              <ColorSwatch
                label="Long"
                value={ext.style.long}
                onChange={(long) => set({ style: { ...ext.style, long } })}
              />
              <ColorSwatch
                label="Short"
                value={ext.style.short}
                onChange={(short) => set({ style: { ...ext.style, short } })}
              />
              <ColorSwatch
                label="Win"
                value={ext.style.win}
                onChange={(win) => set({ style: { ...ext.style, win } })}
              />
              <ColorSwatch
                label="Loss"
                value={ext.style.loss}
                onChange={(loss) => set({ style: { ...ext.style, loss } })}
              />
            </div>
            <div className="stg-dialog-row">
              <label className="stg-input-row">
                <span>Marker size</span>
                <NumberInput
                  aria-label="Marker size"
                  value={ext.style.size}
                  min={2}
                  max={14}
                  onChange={(size) => set({ style: { ...ext.style, size } })}
                />
              </label>
              <label className="stg-input-row">
                <span>History opacity</span>
                <NumberInput
                  aria-label="History opacity"
                  value={ext.style.opacity}
                  step={0.05}
                  min={0.1}
                  max={1}
                  onChange={(opacity) => set({ style: { ...ext.style, opacity } })}
                />
              </label>
            </div>
            {res && (
              <p className="stg-muted tnum" data-testid="chart-strategy-summary">
                History: {res.stats.trades} trades · net {money(res.stats.netPnl)} · win rate{' '}
                {(res.stats.winRate * 100).toFixed(0)}%
              </p>
            )}
            {run?.error && <p className="stg-error">{run.error}</p>}
          </>
        )}
        <div className="stg-dialog-foot">
          {def && (
            <Button
              variant={ext.live ? 'secondary' : 'primary'}
              data-testid="chart-strategy-live"
              onClick={() => {
                set({ live: !ext.live });
                toast(
                  'info',
                  ext.live ? 'Strategy stopped' : 'Strategy running on paper',
                  def.name,
                );
              }}
            >
              {ext.live ? 'Stop live (paper)' : '▶ Run live on paper'}
            </Button>
          )}
          <span className="grow" />
          <Button variant="ghost" onClick={() => openModule('strategies')}>
            Open Strategies
          </Button>
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
