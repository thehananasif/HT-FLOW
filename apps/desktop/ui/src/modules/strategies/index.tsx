import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { RawInputs } from '@htflow/indicator-sdk';
import { resolveInputs } from '@htflow/indicator-sdk';
import {
  DEFAULT_BACKTEST,
  GRID_LIMITS,
  OBJECTIVES,
  STRATEGIES,
  buildGrid,
  heatmapOf,
  rankRows,
  runBacktestAsync,
  strategyById,
  summaryCsv,
  tradesCsv,
  type AnyStrategy,
  type BacktestConfig,
  type BacktestData,
  type BacktestResult,
  type FillModel,
  type Objective,
  type OptimizeRow,
  type WalkForward,
} from '@htflow/strategy';
import {
  Button,
  Checkbox,
  ColorSwatch,
  NumberInput,
  Select,
  Table,
  Tabs,
  toast,
} from '@htflow/ui-kit';
import { registerCommands } from '../../shell/commands';
import { instrumentById } from '../../state/instruments';
import { useWindows } from '../../state/windows';
import { downloadText } from '../../components/DataTable.utils';
import { activeChartId } from '../rss/shared';
import { journalStore } from '../journal/store';
import { registerModule, type ModuleViewProps } from '../registry';
import { DEFAULT_STYLE, EquityCanvas, HeatmapCanvas, type ResultStyle } from './charts';
import {
  backtestInstruments,
  loadHistory,
  rangeOf,
  sanitizeData,
  sourcesFor,
  type DataSetup,
} from './data';
import { liveRuns, liveSummary } from './live';
import { runOptimization } from './optimizeClient';
import {
  BAR_SPECS,
  InputsForm,
  money,
  openModule,
  pct,
  signedMoney,
  specOf,
  specValue,
  toStrategyInstrument,
  tone,
  validColor,
} from './shared';
import { VPS_EVENT, VpsPanel, type VpsAction } from './vps/panel';
import { allTemplates } from '../../trading/atmStore';
import { readStrategyExt, useStrategyDialog, writeStrategyExt } from './chart';
import './chart';
import { Summary, TradesTable, fmtTime } from './results';
import './styles.css';

type MainTab = 'backtest' | 'live' | 'vps';
type ResultTab = 'summary' | 'equity' | 'trades' | 'optimise' | 'log';

interface CostSetup {
  bars: string;
  startingBalance: number;
  commissionPerUnit: number;
  takerFee: number;
  slippageTicks: number;
  fillModel: FillModel;
  /** ATM template id overriding the strategy's brackets ('' = strategy bracket). */
  atm: string;
}

interface AxisSetup {
  key: string;
  from: number;
  to: number;
  step: number;
}

interface OptSetup {
  x: AxisSetup;
  y: AxisSetup;
  objective: Objective;
  /** 0 = walk-forward off. */
  folds: number;
  inSample: number;
}

interface RunState {
  phase: 'idle' | 'loading' | 'running' | 'optimising';
  progress: number;
  message: string;
  result: BacktestResult | null;
  opt: {
    rows: OptimizeRow[];
    folds?: WalkForward['folds'];
    ranOn: string;
    xKey: string;
    yKey: string;
    objective: Objective;
  } | null;
  error: string | null;
  sentToJournal: boolean;
}

const IDLE: RunState = {
  phase: 'idle',
  progress: 0,
  message: '',
  result: null,
  opt: null,
  error: null,
  sentToJournal: false,
};

/** Run state per window (results are large: kept in memory, not in the workspace). */
const useRuns = create<{
  runs: Record<string, RunState>;
  set(id: string, p: Partial<RunState>): void;
}>((set, get) => ({
  runs: {},
  set: (id, p) => set({ runs: { ...get().runs, [id]: { ...(get().runs[id] ?? IDLE), ...p } } }),
}));

/** Actions of mounted windows, for the Command Palette (most recent first). */
interface WindowActions {
  run(): void;
  optimise(): void;
  exportCsv(): void;
  sendToJournal(): void;
  setTab(t: MainTab): void;
}
const mounted: { id: string; actions: WindowActions }[] = [];
const latest = () => mounted[mounted.length - 1]?.actions;

function sanitizeCost(raw: unknown, def: AnyStrategy): CostSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CostSetup>;
  const n = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    bars:
      typeof r.bars === 'string' && BAR_SPECS.some((b) => b.value === r.bars)
        ? r.bars
        : specValue(def.bars ?? { kind: 'time', ms: 300_000 }),
    startingBalance: n(r.startingBalance, DEFAULT_BACKTEST.startingBalance, 100, 1e9),
    commissionPerUnit: n(r.commissionPerUnit, DEFAULT_BACKTEST.commissionPerUnit, 0, 1000),
    takerFee: n(r.takerFee, 0, 0, 0.01),
    slippageTicks: Math.round(n(r.slippageTicks, DEFAULT_BACKTEST.slippageTicks, 0, 100)),
    fillModel: r.fillModel === 'tape' ? 'tape' : 'book',
    atm: typeof r.atm === 'string' ? r.atm : '',
  };
}

function numericKeys(def: AnyStrategy): string[] {
  return Object.entries(def.inputs)
    .filter(([, d]) => d.type === 'int' || d.type === 'float')
    .map(([k]) => k);
}

function defaultAxis(def: AnyStrategy, key: string | undefined, base: RawInputs): AxisSetup {
  const k = key ?? numericKeys(def)[0] ?? '';
  const d = def.inputs[k];
  const v = Number(base[k] ?? (d && 'default' in d ? d.default : 1));
  const step = d && (d.type === 'int' || d.type === 'float') ? d.step : 1;
  return {
    key: k,
    from: Math.max(d && 'min' in d ? d.min : 0, v - 2 * step),
    to: v + 2 * step,
    step,
  };
}

function sanitizeOpt(raw: unknown, def: AnyStrategy, base: RawInputs): OptSetup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<OptSetup>;
  const keys = numericKeys(def);
  const axis = (a: Partial<AxisSetup> | undefined, fallback: string | undefined): AxisSetup => {
    const d = defaultAxis(def, a?.key && keys.includes(a.key) ? a.key : fallback, base);
    const n = (v: unknown, x: number) => (typeof v === 'number' && Number.isFinite(v) ? v : x);
    if (!a || a.key !== d.key) return d;
    return {
      key: d.key,
      from: n(a.from, d.from),
      to: n(a.to, d.to),
      step: Math.abs(n(a.step, d.step)) || d.step,
    };
  };
  return {
    x: axis(r.x, keys[0]),
    y: axis(r.y, keys[1] ?? keys[0]),
    objective: OBJECTIVES.some((o) => o.value === r.objective) ? r.objective! : 'netPnl',
    folds: typeof r.folds === 'number' ? Math.min(10, Math.max(0, Math.round(r.folds))) : 0,
    inSample: typeof r.inSample === 'number' ? Math.min(0.9, Math.max(0.5, r.inSample)) : 0.7,
  };
}

function sanitizeStyle(raw: unknown): ResultStyle {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ResultStyle>;
  return {
    equity: validColor(r.equity, DEFAULT_STYLE.equity),
    drawdown: validColor(r.drawdown, DEFAULT_STYLE.drawdown),
    heatLow: validColor(r.heatLow, DEFAULT_STYLE.heatLow),
    heatHigh: validColor(r.heatHigh, DEFAULT_STYLE.heatHigh),
  };
}


function Strategies({ windowId, state, setParams }: ModuleViewProps) {
  const p = state.params ?? {};
  const strategyId =
    typeof p.strategyId === 'string' && strategyById(p.strategyId)
      ? p.strategyId
      : STRATEGIES[0]!.id;
  const def = strategyById(strategyId)!;
  const allInputs = (p.inputs && typeof p.inputs === 'object' ? p.inputs : {}) as Record<
    string,
    RawInputs
  >;
  const inputs = resolveInputs(def.inputs, allInputs[strategyId]) as RawInputs;
  const data = sanitizeData(p.data);
  const cost = sanitizeCost(p.cost, def);
  const opt = sanitizeOpt(p.opt, def, inputs);
  const style = sanitizeStyle(p.style);
  const tab: MainTab = p.tab === 'live' || p.tab === 'vps' ? p.tab : 'backtest';
  const rtab: ResultTab = (['summary', 'equity', 'trades', 'optimise', 'log'] as const).includes(
    p.resultTab as ResultTab,
  )
    ? (p.resultTab as ResultTab)
    : 'summary';
  const run = useRuns((s) => s.runs[windowId] ?? IDLE);
  const setRun = (patch: Partial<RunState>) => useRuns.getState().set(windowId, patch);
  const abort = useRef<AbortController | null>(null);
  const dataCache = useRef<{ key: string; data: BacktestData } | null>(null);
  const instruments = useMemo(() => backtestInstruments(), []);
  const inst = instrumentById(data.instrumentId) ?? instruments[0];
  const sources = sourcesFor(data.instrumentId);

  const setInputs = (v: RawInputs) => setParams({ inputs: { ...allInputs, [strategyId]: v } });
  const setData = (patch: Partial<DataSetup>) => setParams({ data: { ...data, ...patch } });
  const setCost = (patch: Partial<CostSetup>) => setParams({ cost: { ...cost, ...patch } });
  const setOpt = (patch: Partial<OptSetup>) => setParams({ opt: { ...opt, ...patch } });

  const config = (): BacktestConfig | null =>
    inst
      ? {
          instrument: toStrategyInstrument(inst),
          bars: specOf(cost.bars),
          startingBalance: cost.startingBalance,
          commissionPerUnit: cost.commissionPerUnit,
          takerFee: cost.takerFee,
          slippageTicks: cost.slippageTicks,
          fillModel: cost.fillModel,
          atmTemplates: allTemplates(),
          atmOverride: cost.atm || undefined,
        }
      : null;

  const getData = async (): Promise<BacktestData> => {
    const depth = cost.fillModel === 'book';
    const key = JSON.stringify([data, depth]);
    if (dataCache.current?.key === key) return dataCache.current.data;
    setRun({ phase: 'loading', progress: 0, message: 'Loading history…', error: null });
    const { dataset, source } = await loadHistory(data, depth, (pr) => setRun({ progress: pr }));
    setRun({ message: `${dataset.trades.length.toLocaleString()} trades from ${source.label}` });
    dataCache.current = { key, data: dataset };
    return dataset;
  };

  const runBacktest = async (overrides?: RawInputs) => {
    const cfg = config();
    if (!cfg || run.phase !== 'idle') return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const d = await getData();
      setRun({ phase: 'running', progress: 0 });
      const res = await runBacktestAsync(def, overrides ?? inputs, d, cfg, {
        signal: ctrl.signal,
        onProgress: (pr) => setRun({ progress: pr }),
      });
      setRun({ phase: 'idle', result: res, sentToJournal: false, progress: 1 });
      if (rtab === 'optimise' || rtab === 'log') setParams({ resultTab: 'summary' });
    } catch (e) {
      setRun({ phase: 'idle', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const optimise = async () => {
    const cfg = config();
    if (!cfg || run.phase !== 'idle') return;
    const ranges = [opt.x, ...(opt.y.key !== opt.x.key ? [opt.y] : [])];
    const n = buildGrid(def.inputs, inputs, ranges).length;
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const d = await getData();
      setRun({ phase: 'optimising', progress: 0, message: `Optimising ${n} combinations…` });
      setParams({ resultTab: 'optimise' });
      const out = await runOptimization(
        {
          strategyId,
          base: inputs,
          ranges,
          data: d,
          config: cfg,
          objective: opt.objective,
          walkForward: opt.folds > 0 ? { folds: opt.folds, inSample: opt.inSample } : undefined,
        },
        (pr) => setRun({ progress: pr }),
        ctrl.signal,
      );
      setRun({
        phase: 'idle',
        progress: 1,
        message: `${out.rows.length} combinations (${out.ranOn === 'worker' ? 'Web Worker' : 'UI thread'})`,
        opt: { ...out, xKey: opt.x.key, yKey: opt.y.key, objective: opt.objective },
      });
    } catch (e) {
      setRun({ phase: 'idle', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const exportCsv = () => {
    const r = useRuns.getState().runs[windowId]?.result;
    if (!r) return toast('info', 'Run a backtest first');
    const name = `${r.strategyId}-${r.config.instrument.symbol}`;
    downloadText(`${name}-trades.csv`, tradesCsv(r));
    downloadText(`${name}-summary.csv`, summaryCsv(r));
  };

  const sendToJournal = () => {
    const r = useRuns.getState().runs[windowId]?.result;
    if (!r || !r.trades.length) return toast('info', 'No backtest trades to send');
    const stamp = Date.now().toString(36);
    const trips = r.trades.map((t) => ({
      id: `bt-${stamp}-${t.n}`,
      instrumentId: t.instrumentId,
      accountId: 'backtest',
      side: t.side,
      qty: t.qty,
      entryPx: t.entryPx,
      exitPx: t.exitPx,
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      pnl: t.pnl,
      commission: t.commission,
      ...(t.risk ? { risk: t.risk } : {}),
    }));
    const n = journalStore.importTrips(trips, [
      { text: 'backtest', kind: 'custom' },
      { text: def.name, kind: 'setup' },
    ]);
    setRun({ sentToJournal: true });
    toast('success', `${n} trades sent to the Journal`, 'Tagged “backtest”.');
  };

  const actions: WindowActions = {
    run: () => void runBacktest(),
    optimise: () => void optimise(),
    exportCsv,
    sendToJournal,
    setTab: (t) => setParams({ tab: t }),
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const entry = {
      id: windowId,
      actions: {
        run: () => actionsRef.current.run(),
        optimise: () => actionsRef.current.optimise(),
        exportCsv: () => actionsRef.current.exportCsv(),
        sendToJournal: () => actionsRef.current.sendToJournal(),
        setTab: (t: MainTab) => actionsRef.current.setTab(t),
      },
    };
    mounted.push(entry);
    return () => {
      const i = mounted.indexOf(entry);
      if (i >= 0) mounted.splice(i, 1);
    };
  }, [windowId]);

  const busy = run.phase !== 'idle';
  const range = rangeOf(data);
  const res = run.result;

  return (
    <div className="module-window stg-win" data-testid="strategies-window">
      <div className="stg-top">
        <b>Strategies</b>
        <Tabs
          value={tab}
          onChange={(t) => setParams({ tab: t })}
          tabs={[
            { value: 'backtest', label: 'Backtest' },
            { value: 'live', label: `Running (${liveRuns.list().length})` },
            { value: 'vps', label: 'VPS runner' },
          ]}
        />
      </div>
      {tab === 'live' && <LivePanel />}
      {tab === 'vps' && <VpsPanel />}
      {tab === 'backtest' && (
        <div className="stg-body">
          <aside className="stg-list" aria-label="Strategy list">
            {STRATEGIES.map((s) => (
              <button
                key={s.id}
                className="stg-item"
                aria-pressed={s.id === strategyId}
                data-testid={`strategy-${s.id}`}
                onClick={() =>
                  setParams({
                    strategyId: s.id,
                    opt: undefined,
                    cost: { ...cost, bars: specValue(s.bars ?? { kind: 'time', ms: 300_000 }) },
                  })
                }
              >
                <span className="stg-item-name">{s.name}</span>
                <span className="stg-item-cat">{s.category}</span>
              </button>
            ))}
            <p className="stg-muted stg-list-note">
              Write your own with <code>defineStrategy</code> from <code>@htflow/strategy</code>.
            </p>
          </aside>
          <section className="stg-setup" aria-label="Backtest setup">
            <p className="stg-desc">{def.description}</p>
            <div className="stg-subhead">Inputs</div>
            <InputsForm
              defs={def.inputs}
              values={inputs}
              onChange={setInputs}
              testId="strategy-inputs"
            />
            <div className="stg-subhead">Data</div>
            <div className="stg-inputs">
              <label className="stg-input-row">
                <span>Instrument</span>
                <Select
                  small
                  aria-label="Instrument"
                  value={data.instrumentId}
                  options={instruments.map((i) => ({
                    value: i.id,
                    label: `${i.symbol} · ${i.exchange}`,
                  }))}
                  onChange={(instrumentId) => setData({ instrumentId, source: '' })}
                />
              </label>
              <label className="stg-input-row">
                <span>Source</span>
                <Select
                  small
                  aria-label="Data source"
                  value={data.source}
                  options={[
                    { value: '', label: sources[0] ? `Auto (${sources[0].label})` : 'No data' },
                    ...sources.map((s) => ({ value: s.id, label: s.label })),
                  ]}
                  onChange={(source) => setData({ source })}
                />
              </label>
              <label className="stg-input-row">
                <span>Day (UTC)</span>
                <input
                  type="date"
                  className="ht-input"
                  aria-label="Day"
                  value={data.day || new Date(range.from).toISOString().slice(0, 10)}
                  onChange={(e) => setData({ day: e.target.value })}
                />
              </label>
              <label className="stg-input-row">
                <span>From hour</span>
                <NumberInput
                  aria-label="From hour"
                  value={data.fromHour}
                  min={0}
                  max={23}
                  unit="UTC"
                  onChange={(fromHour) => setData({ fromHour })}
                />
              </label>
              <label className="stg-input-row">
                <span>Length</span>
                <NumberInput
                  aria-label="Hours"
                  value={data.hours}
                  min={1}
                  max={720}
                  unit="h"
                  onChange={(hours) => setData({ hours })}
                />
              </label>
              <label className="stg-input-row">
                <span>Bars</span>
                <Select
                  small
                  aria-label="Bars"
                  value={cost.bars}
                  options={BAR_SPECS.map((b) => ({ value: b.value, label: b.label }))}
                  onChange={(bars) => setCost({ bars })}
                />
              </label>
            </div>
            <div className="stg-subhead">Fills &amp; costs</div>
            <div className="stg-inputs">
              <label className="stg-input-row">
                <span>Fill model</span>
                <Select
                  small
                  aria-label="Fill model"
                  value={cost.fillModel}
                  options={[
                    { value: 'book', label: 'Recorded book + tape' },
                    { value: 'tape', label: 'Tape only (top of book)' },
                  ]}
                  onChange={(fillModel) => setCost({ fillModel })}
                />
              </label>
              <label
                className="stg-input-row"
                title="ATM template from the trading panel replaces the strategy's stop / targets"
              >
                <span>Exit management</span>
                <Select
                  small
                  aria-label="Exit management"
                  value={allTemplates().some((t) => t.id === cost.atm) ? cost.atm : ''}
                  options={[
                    { value: '', label: 'Strategy bracket' },
                    ...allTemplates().map((t) => ({ value: t.id, label: `ATM: ${t.name}` })),
                  ]}
                  onChange={(atm) => setCost({ atm })}
                />
              </label>
              <label className="stg-input-row">
                <span>Commission</span>
                <NumberInput
                  aria-label="Commission"
                  value={cost.commissionPerUnit}
                  step={0.01}
                  min={0}
                  max={1000}
                  unit="/side"
                  onChange={(commissionPerUnit) => setCost({ commissionPerUnit })}
                />
              </label>
              <label className="stg-input-row">
                <span>Taker fee</span>
                <NumberInput
                  aria-label="Taker fee"
                  value={cost.takerFee}
                  step={0.0001}
                  min={0}
                  max={0.01}
                  onChange={(takerFee) => setCost({ takerFee })}
                />
              </label>
              <label className="stg-input-row">
                <span>Slippage</span>
                <NumberInput
                  aria-label="Slippage"
                  value={cost.slippageTicks}
                  min={0}
                  max={100}
                  unit="ticks"
                  onChange={(slippageTicks) => setCost({ slippageTicks })}
                />
              </label>
              <label className="stg-input-row">
                <span>Start balance</span>
                <NumberInput
                  aria-label="Start balance"
                  value={cost.startingBalance}
                  step={1000}
                  min={100}
                  max={1e9}
                  onChange={(startingBalance) => setCost({ startingBalance })}
                />
              </label>
            </div>
            <div className="stg-run">
              <Button
                data-testid="strategy-run"
                disabled={busy || !inst}
                onClick={() => void runBacktest()}
              >
                ▶ Run backtest
              </Button>
              {busy && (
                <Button variant="ghost" onClick={() => abort.current?.abort()}>
                  Cancel
                </Button>
              )}
            </div>
            {(busy || run.message) && (
              <div className="stg-progress" data-testid="strategy-progress" aria-busy={busy}>
                <div className="stg-bar">
                  <span style={{ width: `${Math.round(run.progress * 100)}%` }} />
                </div>
                <span className="stg-muted tnum">
                  {busy ? `${run.phase} ${Math.round(run.progress * 100)}%` : ''} {run.message}
                </span>
              </div>
            )}
            {run.error && (
              <p className="stg-error" role="alert">
                {run.error}
              </p>
            )}
          </section>
          <section className="stg-results" aria-label="Results">
            <div className="stg-results-head">
              <Tabs
                value={rtab}
                onChange={(t) => setParams({ resultTab: t })}
                tabs={[
                  { value: 'summary', label: 'Summary' },
                  { value: 'equity', label: 'Equity' },
                  { value: 'trades', label: `Trades${res ? ` (${res.trades.length})` : ''}` },
                  { value: 'optimise', label: 'Optimise' },
                  { value: 'log', label: 'Log' },
                ]}
              />
              <span className="grow" />
              <Button
                size="xs"
                variant="secondary"
                disabled={!res}
                onClick={exportCsv}
                data-testid="strategy-export"
              >
                Export CSV
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={!res?.trades.length || run.sentToJournal}
                onClick={sendToJournal}
                data-testid="strategy-journal"
              >
                {run.sentToJournal ? 'Sent to Journal' : 'Send trades to Journal'}
              </Button>
            </div>
            <div className="stg-results-body">
              {rtab === 'optimise' ? (
                <OptimisePanel
                  def={def}
                  inputs={inputs}
                  opt={opt}
                  setOpt={setOpt}
                  state={run}
                  busy={busy}
                  style={style}
                  setStyle={(st) => setParams({ style: st })}
                  onRun={() => void optimise()}
                  onPick={(v) => {
                    setInputs(resolveInputs(def.inputs, { ...inputs, ...v }) as RawInputs);
                    toast(
                      'info',
                      'Inputs applied',
                      Object.entries(v)
                        .map(([k, x]) => `${k} = ${x}`)
                        .join(', '),
                    );
                  }}
                />
              ) : !res ? (
                <div className="stg-empty">
                  Pick a strategy, check the inputs and press <b>Run backtest</b>. Simulated history
                  is generated offline; recorded tick-store data is used when available.
                </div>
              ) : rtab === 'summary' ? (
                <Summary r={res} />
              ) : rtab === 'equity' ? (
                <div className="stg-equity">
                  <EquityCanvas result={res} style={style} />
                  <div className="stg-style-row">
                    <ColorSwatch
                      label="Equity"
                      value={style.equity}
                      onChange={(equity) => setParams({ style: { ...style, equity } })}
                    />
                    <ColorSwatch
                      label="Drawdown"
                      value={style.drawdown}
                      onChange={(drawdown) => setParams({ style: { ...style, drawdown } })}
                    />
                  </div>
                </div>
              ) : rtab === 'trades' ? (
                <TradesTable r={res} />
              ) : (
                <pre className="stg-log" data-testid="strategy-log">
                  {res.logs.length
                    ? res.logs.map((l) => `${fmtTime(l.ts)}  ${l.text}`).join('\n')
                    : 'No log lines.'}
                </pre>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function OptimisePanel({
  def,
  inputs,
  opt,
  setOpt,
  state,
  busy,
  style,
  setStyle,
  onRun,
  onPick,
}: {
  def: AnyStrategy;
  inputs: RawInputs;
  opt: OptSetup;
  setOpt(p: Partial<OptSetup>): void;
  state: RunState;
  busy: boolean;
  style: ResultStyle;
  setStyle(s: ResultStyle): void;
  onRun(): void;
  onPick(v: RawInputs): void;
}) {
  const keys = numericKeys(def);
  const ranges = [opt.x, ...(opt.y.key !== opt.x.key ? [opt.y] : [])];
  const combos = buildGrid(def.inputs, inputs, ranges).length;
  const o = state.opt;
  const map = useMemo(() => (o ? heatmapOf(o.rows, o.xKey, o.yKey) : null), [o]);
  const ranked = useMemo(() => (o ? rankRows(o.rows).slice(0, 8) : []), [o]);
  const fmt = (v: number) =>
    o?.objective === 'winRate'
      ? pct(v, 0)
      : o?.objective === 'netPnl' || o?.objective === 'expectancy'
        ? money(v)
        : v.toFixed(2);
  const axis = (which: 'x' | 'y') => {
    const a = opt[which];
    const d = def.inputs[a.key];
    const step = d && (d.type === 'int' || d.type === 'float') ? d.step : 1;
    return (
      <div className="stg-axis">
        <Select
          small
          aria-label={`${which.toUpperCase()} parameter`}
          value={a.key}
          options={keys.map((k) => ({ value: k, label: def.inputs[k]!.label }))}
          onChange={(key) => setOpt({ [which]: defaultAxis(def, key, inputs) })}
        />
        <NumberInput
          aria-label={`${which} from`}
          value={a.from}
          step={step}
          onChange={(from) => setOpt({ [which]: { ...a, from } })}
        />
        <span className="stg-muted">→</span>
        <NumberInput
          aria-label={`${which} to`}
          value={a.to}
          step={step}
          onChange={(to) => setOpt({ [which]: { ...a, to } })}
        />
        <span className="stg-muted">step</span>
        <NumberInput
          aria-label={`${which} step`}
          value={a.step}
          step={step}
          min={step}
          onChange={(s) => setOpt({ [which]: { ...a, step: s } })}
        />
      </div>
    );
  };
  return (
    <div className="stg-opt" data-testid="strategy-optimise">
      <div className="stg-opt-setup">
        <label className="stg-input-row">
          <span>X axis</span>
          {axis('x')}
        </label>
        <label className="stg-input-row">
          <span>Y axis</span>
          {axis('y')}
        </label>
        <div className="stg-opt-row">
          <label className="stg-input-row">
            <span>Objective</span>
            <Select
              small
              aria-label="Objective"
              value={opt.objective}
              options={OBJECTIVES}
              onChange={(objective) => setOpt({ objective })}
            />
          </label>
          <label className="stg-input-row">
            <span>Walk-forward folds</span>
            <NumberInput
              aria-label="Walk-forward folds"
              value={opt.folds}
              min={0}
              max={10}
              onChange={(folds) => setOpt({ folds })}
            />
          </label>
          <label className="stg-input-row">
            <span>In-sample</span>
            <NumberInput
              aria-label="In-sample share"
              value={opt.inSample}
              step={0.05}
              min={0.5}
              max={0.9}
              onChange={(inSample) => setOpt({ inSample })}
            />
          </label>
          <Checkbox
            checked={opt.folds > 0}
            onChange={(v) => setOpt({ folds: v ? Math.max(2, opt.folds) : 0 })}
            label="Walk-forward"
          />
          <span className="grow" />
          <span className="stg-muted tnum">
            {combos} combinations (max {GRID_LIMITS.combos})
          </span>
          <Button
            size="sm"
            disabled={busy || combos < 1}
            onClick={onRun}
            data-testid="strategy-optimise-run"
          >
            Optimise
          </Button>
        </div>
      </div>
      {map && o ? (
        <div className="stg-opt-results">
          <HeatmapCanvas
            map={map}
            style={style}
            format={fmt}
            onPick={(x, y) => onPick({ [map.xKey]: x, [map.yKey]: y })}
          />
          <div className="stg-opt-side">
            <div className="stg-subhead">Best combinations</div>
            <table className="stg-mini tnum">
              <tbody>
                {ranked.map((r, i) => (
                  <tr key={i} onClick={() => onPick(r.inputs)} title="Use these inputs">
                    <td>
                      {o.xKey}={String(r.inputs[o.xKey])}
                    </td>
                    <td>
                      {o.yKey}={String(r.inputs[o.yKey])}
                    </td>
                    <td className={tone(r.stats.netPnl)}>{signedMoney(r.stats.netPnl)}</td>
                    <td>{r.stats.trades} tr</td>
                    <td>{Number.isFinite(r.score) ? fmt(r.score) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {o.folds && (
              <>
                <div className="stg-subhead">Walk-forward (out of sample)</div>
                <table className="stg-mini tnum" data-testid="strategy-walkforward">
                  <tbody>
                    {o.folds.map((f, i) => (
                      <tr key={i}>
                        <td>#{i + 1}</td>
                        <td>{fmtTime(f.oosFrom).slice(6)}</td>
                        <td>
                          {f.best
                            ? `${o.xKey}=${String(f.best[o.xKey])} ${o.yKey}=${String(f.best[o.yKey])}`
                            : 'no trades in-sample'}
                        </td>
                        <td className={tone(f.oos?.stats.netPnl ?? 0)}>
                          {f.oos ? signedMoney(f.oos.stats.netPnl) : '—'}
                        </td>
                        <td>{f.oos?.stats.trades ?? 0} tr</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <div className="stg-style-row">
              <ColorSwatch
                label="Low"
                value={style.heatLow}
                onChange={(heatLow) => setStyle({ ...style, heatLow })}
              />
              <ColorSwatch
                label="High"
                value={style.heatHigh}
                onChange={(heatHigh) => setStyle({ ...style, heatHigh })}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="stg-empty">
          Choose two numeric inputs and their ranges, then press <b>Optimise</b>. Each combination
          is a full backtest on the selected data (in a Web Worker); walk-forward re-optimises on
          each in-sample window and trades the winner out of sample.
        </div>
      )}
    </div>
  );
}

/** Live strategies on charts (P42 "Trading strategies" table). */
function LivePanel() {
  const [, set] = useState(0);
  useEffect(() => {
    const a = liveRuns.subscribe(() => set((x) => x + 1));
    const i = setInterval(() => set((x) => x + 1), 1000);
    return () => {
      a();
      clearInterval(i);
    };
  }, []);
  const windows = useWindows((s) => s.windows);
  const charts = Object.entries(windows).filter(([, w]) => w.kind === 'chart');
  const rows = charts
    .map(([id, w]) => ({ id, w, ext: readStrategyExt(id) }))
    .filter((r) => r.ext.strategyId);
  return (
    <div className="stg-live" data-testid="strategy-live">
      <div className="stg-card-head">
        <span className="stg-muted">
          Strategies attached to charts. Live ones trade the paper account on This PC.
        </span>
        <span className="grow" />
        <Button size="sm" variant="secondary" onClick={() => attachToActiveChart()}>
          + Attach to active chart
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={!liveRuns.list().length}
          onClick={() => stopAll()}
        >
          Stop all
        </Button>
      </div>
      <Table
        aria-label="Chart strategies"
        rows={rows}
        rowId={(r) => r.id}
        height={260}
        empty="No strategy attached to a chart. Use “Attach to active chart” or the chart's Strategy chip."
        columns={[
          { key: 'name', header: 'Strategy', render: (r) => strategyById(r.ext.strategyId!)?.name },
          {
            key: 'inst',
            header: 'Instrument',
            width: 90,
            render: (r) =>
              r.w.kind === 'chart'
                ? (instrumentById(r.w.instrumentId)?.symbol ?? r.w.instrumentId)
                : '',
          },
          { key: 'acc', header: 'Account', width: 80, render: () => 'Paper' },
          { key: 'on', header: 'Runs on', width: 70, render: () => 'This PC' },
          {
            key: 'status',
            header: 'Status',
            width: 80,
            render: (r) => {
              const run = liveRuns.get(r.id);
              return run ? (
                <span className={run.status === 'error' ? 'down' : 'up'}>
                  {run.status === 'error' ? 'Error' : 'Running'}
                </span>
              ) : (
                <span className="stg-muted">Backtest</span>
              );
            },
          },
          {
            key: 'pnl',
            header: 'P&L today',
            width: 90,
            numeric: true,
            render: (r) => {
              const run = liveRuns.get(r.id);
              if (!run) return '—';
              const s = liveSummary(run);
              return (
                <span className={tone(s.today + s.openPnl)}>
                  {signedMoney(s.today + s.openPnl, 2)}
                </span>
              );
            },
          },
          {
            key: 'trades',
            header: 'Trades',
            width: 56,
            numeric: true,
            render: (r) => (liveRuns.get(r.id) ? liveSummary(liveRuns.get(r.id)!).trades : '—'),
          },
          {
            key: 'act',
            header: '',
            width: 150,
            render: (r) => (
              <span className="stg-row-actions">
                <Button
                  size="xs"
                  variant={liveRuns.get(r.id) ? 'secondary' : 'primary'}
                  onClick={() => writeStrategyExt(r.id, { live: !r.ext.live })}
                >
                  {liveRuns.get(r.id) ? 'Stop' : 'Start'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => useStrategyDialog.getState().open(r.id)}
                >
                  Edit
                </Button>
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}

function attachToActiveChart(strategyId?: string): void {
  const id = activeChartId();
  if (!id) {
    toast('info', 'Open a chart first');
    return;
  }
  if (strategyId) writeStrategyExt(id, { strategyId, inputs: {} });
  useStrategyDialog.getState().open(id);
}

function stopAll(): void {
  const n = liveRuns.list().length;
  for (const r of liveRuns.list()) writeStrategyExt(r.key, { live: false });
  liveRuns.stopAll(true);
  toast('info', `${n} strategies stopped and flattened`);
}

registerModule({ id: 'strategies', view: Strategies });

const withWindow = (fn: (a: WindowActions) => void) => () => {
  openModule('strategies');
  setTimeout(() => {
    const a = latest();
    if (a) fn(a);
  }, 50);
};

registerCommands([
  {
    id: 'strategies.open',
    label: 'Open Strategies',
    group: 'Trading',
    keywords: 'strategy backtest optimise algo automated',
    run: () => openModule('strategies'),
  },
  {
    id: 'strategies.run',
    label: 'Strategies: Run backtest',
    group: 'Trading',
    keywords: 'backtest strategy test',
    run: withWindow((a) => a.run()),
  },
  {
    id: 'strategies.optimise',
    label: 'Strategies: Optimise inputs (grid search)',
    group: 'Trading',
    keywords: 'optimize optimise grid walk-forward heatmap parameters',
    run: withWindow((a) => {
      a.setTab('backtest');
      a.optimise();
    }),
  },
  {
    id: 'strategies.export',
    label: 'Strategies: Export results to CSV',
    group: 'Trading',
    keywords: 'csv export backtest trades',
    run: withWindow((a) => a.exportCsv()),
  },
  {
    id: 'strategies.journal',
    label: 'Strategies: Send backtest trades to Journal',
    group: 'Trading',
    keywords: 'journal backtest trades tag',
    run: withWindow((a) => a.sendToJournal()),
  },
  {
    id: 'strategies.running',
    label: 'Strategies: Show running strategies',
    group: 'Trading',
    keywords: 'live paper running stop',
    run: withWindow((a) => a.setTab('live')),
  },
  {
    id: 'strategies.vps',
    label: 'Strategies: VPS runner',
    group: 'Trading',
    keywords: 'vps remote runner deploy ssh server',
    run: withWindow((a) => a.setTab('vps')),
  },
  ...(
    [
      ['add', 'Strategies: Add VPS (SSH)…', 'vps ssh server add host key'],
      ['deploy', 'Strategies: Deploy strategy to VPS…', 'vps deploy runner remote paper'],
      ['refresh', 'Strategies: Refresh VPS runners', 'vps status poll uptime pnl'],
      ['import', 'Strategies: Import VPS fills to Journal', 'vps journal fills trades import'],
    ] as [VpsAction, string, string][]
  ).map(([a, label, keywords]) => ({
    id: `strategies.vps-${a}`,
    label,
    group: 'Trading' as const,
    keywords,
    run: withWindow((w) => {
      w.setTab('vps');
      setTimeout(() => window.dispatchEvent(new CustomEvent(VPS_EVENT, { detail: a })), 60);
    }),
  })),
  {
    id: 'strategies.attach',
    label: 'Chart: Attach strategy…',
    group: 'Chart',
    keywords: 'strategy chart markers live paper',
    run: () => attachToActiveChart(),
  },
  {
    id: 'strategies.toggle-live',
    label: 'Chart: Start / stop live strategy (paper)',
    group: 'Chart',
    keywords: 'strategy live paper enable disable',
    run: () => {
      const id = activeChartId();
      if (!id) return;
      const ext = readStrategyExt(id);
      if (!ext.strategyId) return attachToActiveChart();
      writeStrategyExt(id, { live: !ext.live });
    },
  },
  {
    id: 'strategies.stop-all',
    label: 'Strategies: Stop all and flatten',
    group: 'Trading',
    keywords: 'kill switch stop strategies flatten',
    run: stopAll,
  },
]);
