/**
 * HT Editor: write strategies in JavaScript / TypeScript-like syntax against the HT Strategy API
 * (docs/STRATEGY-API.md), backtest them, run them on paper or (armed) live, deploy them to your
 * VPS. User code only ever runs in the sandbox worker; every order it asks for is validated here
 * and then passes the RiskEngine.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { input, type InputDefs, type RawInputs } from '@htflow/indicator-sdk';
import {
  DEFAULT_LIMITS,
  SCRIPT_TEMPLATES,
  parseHtstrat,
  parseTimeframe,
  runScriptBacktest,
  serializeHtstrat,
  validFileName,
  type ParamDecl,
  type ScriptBacktestResult,
  type ScriptDescription,
  type StrategyProject,
} from '@htflow/strategy';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Input,
  NumberInput,
  Select,
  Table,
  Tabs,
  toast,
} from '@htflow/ui-kit';
import { downloadText } from '../../../components/DataTable.utils';
import { instrumentById } from '../../../state/instruments';
import { DEFAULT_STYLE, EquityCanvas, useCanvas } from '../charts';
import { backtestInstruments, loadHistory, rangeOf, sanitizeData, type DataSetup } from '../data';
import { liveRuns } from '../live';
import { Summary, TradesTable, fmtTime } from '../results';
import {
  BAR_SPECS,
  InputsForm,
  cssVar,
  signedMoney,
  specOf,
  toStrategyInstrument,
  tone,
} from '../shared';
import { CodeEditor } from './CodeEditor';
import { compileProject, type Diagnostic } from './compile';
import { liveRouters, runStats, scriptRuns, type LiveOrderRouter, type ScriptRun } from './runs';
import {
  deleteProject,
  newProject,
  projectById,
  saveProject,
  useScripts,
  vpsDeployRequest,
} from './store';
import { WorkerTransport } from './workerTransport';
import './editor.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
type ResultTab = 'problems' | 'summary' | 'equity' | 'plots' | 'trades' | 'log' | 'runs';

export interface EditorSettings {
  data: DataSetup;
  /** '' = the script's own `meta.timeframe`. */
  bars: string;
  maxOrderQty: number;
  maxPosition: number;
  dailyLoss: number;
  budgetMs: number;
  commissionPerUnit: number;
  slippageTicks: number;
}

export function sanitizeSettings(raw: unknown): EditorSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<EditorSettings>;
  const n = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    data: sanitizeData(r.data),
    bars:
      typeof r.bars === 'string' && (r.bars === '' || BAR_SPECS.some((b) => b.value === r.bars))
        ? r.bars
        : '',
    maxOrderQty: n(r.maxOrderQty, 5, 0.0001, 1e6),
    maxPosition: n(r.maxPosition, 5, 0.0001, 1e6),
    dailyLoss: n(r.dailyLoss, 1000, 0, 1e9),
    budgetMs: Math.round(n(r.budgetMs, DEFAULT_LIMITS.budgetMs, 10, 5000)),
    commissionPerUnit: n(r.commissionPerUnit, 2.5, 0, 1000),
    slippageTicks: Math.round(n(r.slippageTicks, 1, 0, 100)),
  };
}

interface EditorState {
  project: StrategyProject;
  file: number;
  savedJson: string;
  desc: ScriptDescription | null;
  descError: Diagnostic | null;
  phase: 'idle' | 'loading' | 'running';
  progress: number;
  result: ScriptBacktestResult | null;
  runtime: Diagnostic | null;
  rtab: ResultTab;
}

const useEditors = create<{
  byWindow: Record<string, EditorState>;
  set(id: string, p: Partial<EditorState>): void;
}>((set, get) => ({
  byWindow: {},
  set: (id, p) => {
    const cur = get().byWindow[id];
    if (cur) set({ byWindow: { ...get().byWindow, [id]: { ...cur, ...p } } });
  },
}));

function initial(projectId: unknown): EditorState {
  const saved = typeof projectId === 'string' ? projectById(projectId) : undefined;
  const project = saved ?? newProject('ma-cross');
  return {
    project,
    file: 0,
    savedJson: saved ? JSON.stringify(saved.files) : '',
    desc: null,
    descError: null,
    phase: 'idle',
    progress: 0,
    result: null,
    runtime: null,
    rtab: 'problems',
  };
}

/** Param declarations → InputDefs for the shared settings form. */
export function paramDefs(params: Record<string, ParamDecl>): InputDefs {
  const out: InputDefs = {};
  for (const [k, d] of Object.entries(params)) {
    switch (d.type) {
      case 'int':
        out[k] = input.int(d.label, d.default, {
          min: d.min ?? -1e9,
          max: d.max ?? 1e9,
          step: d.step ?? 1,
        });
        break;
      case 'float':
        out[k] = input.float(d.label, d.default, {
          min: d.min ?? -1e12,
          max: d.max ?? 1e12,
          step: d.step ?? 0.1,
        });
        break;
      case 'bool':
        out[k] = input.bool(d.label, d.default);
        break;
      case 'choice':
        out[k] = input.enum(
          d.label,
          d.default,
          d.options.map((o) => [o, o] as const),
        );
        break;
      default:
        out[k] = input.string(d.label, d.default, { maxLength: 256 });
    }
  }
  return out;
}

/** Actions of mounted editors for the Command Palette (most recent last). */
export interface EditorActions {
  newStrategy(templateId?: string): void;
  backtest(): void;
  paper(): void;
  stop(): void;
  save(): void;
  importFile(): void;
  exportFile(): void;
  open(projectId: string): void;
}
export const editorMounted: { id: string; actions: EditorActions }[] = [];

function useRunsVersion(): number {
  return useSyncExternalStore(scriptRuns.subscribe, scriptRuns.version);
}

export function HtEditor({
  windowId,
  params,
  setParams,
  onDeployVps,
}: {
  windowId: string;
  params: Record<string, unknown>;
  setParams(p: Record<string, unknown>): void;
  onDeployVps(): void;
}) {
  const ed =
    params.editor && typeof params.editor === 'object'
      ? (params.editor as Record<string, unknown>)
      : {};
  const settings = sanitizeSettings(ed.settings);
  const st = useEditors((s) => s.byWindow[windowId]);
  if (!st)
    useEditors.setState((s) => ({
      byWindow: { ...s.byWindow, [windowId]: initial(ed.projectId) },
    }));
  const state = st ?? initial(ed.projectId);
  const set = (p: Partial<EditorState>) => useEditors.getState().set(windowId, p);
  const scripts = useScripts();
  useRunsVersion();
  const fileInput = useRef<HTMLInputElement>(null);
  const [armOpen, setArmOpen] = useState(false);
  const [logRun, setLogRun] = useState<string | null>(null);
  const instruments = useMemo(() => backtestInstruments(), []);

  const { project, file } = state;
  const cur = project.files[Math.min(file, project.files.length - 1)]!;
  const setSettings = (p: Partial<EditorSettings>) =>
    setParams({ editor: { ...ed, settings: { ...settings, ...p } } });
  const setProject = (p: StrategyProject) => set({ project: p });
  const dirty =
    JSON.stringify(project.files) !== state.savedJson || !scripts.some((s) => s.id === project.id);

  const compiled = useMemo(() => compileProject(project.files), [project.files]);
  const diagnostics = useMemo(() => {
    const all = [...compiled.diagnostics];
    if (state.descError) all.push(state.descError);
    if (state.runtime) all.push(state.runtime);
    return all;
  }, [compiled, state.descError, state.runtime]);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;

  // Describe the script (params form, timeframe) in a throw-away sandbox after edits settle.
  useEffect(() => {
    if (!compiled.project) return;
    const proj = compiled.project;
    let t: WorkerTransport | null = null;
    let cancelled = false;
    const h = setTimeout(() => {
      try {
        t = new WorkerTransport();
      } catch {
        return;
      }
      const inst = instrumentById(settings.data.instrumentId) ?? instruments[0];
      if (!inst) return;
      t.load(proj, project.params, toStrategyInstrument(inst), DEFAULT_LIMITS)
        .then((desc) => !cancelled && set({ desc, descError: null }))
        .catch((e: { message?: string; line?: number; column?: number; file?: string }) => {
          if (cancelled) return;
          set({
            descError: {
              file: e.file ?? project.files[0]!.name,
              line: e.line ?? 1,
              column: e.column ?? 0,
              message: e.message ?? String(e),
              severity: 'error',
            },
          });
        })
        .finally(() => t?.dispose());
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(h);
      t?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled]);

  const desc = state.desc;
  const defs = useMemo(() => paramDefs(desc?.params ?? {}), [desc]);
  const inst = instrumentById(settings.data.instrumentId) ?? instruments[0];
  const barsSpec = settings.bars
    ? specOf(settings.bars)
    : (parseTimeframe(desc?.timeframe ?? '5m') ?? undefined);
  const limits = {
    maxOrderQty: settings.maxOrderQty,
    maxPosition: settings.maxPosition,
    maxPriceDeviation: 0.2,
    maxBracketTicks: 10_000,
  };

  const save = () => {
    saveProject(project);
    set({ savedJson: JSON.stringify(project.files) });
    setParams({ editor: { ...ed, projectId: project.id } });
    toast('success', tt`Saved ${project.name}`);
  };

  const open = (p: StrategyProject) => {
    set({ ...initial(null), project: p, savedJson: JSON.stringify(p.files) });
    setParams({ editor: { ...ed, projectId: p.id } });
  };

  const newStrategy = (templateId?: string) => {
    const p = newProject(templateId);
    set({ ...initial(null), project: p, savedJson: '' });
    setParams({ editor: { ...ed, projectId: p.id } });
  };

  const backtest = async () => {
    if (state.phase !== 'idle') return;
    if (!compiled.project) {
      set({ rtab: 'problems' });
      return toast('error', tl('Fix the errors first'), tt`${errors} error(s) in the code`);
    }
    if (!inst) return toast('error', tl('No instrument with history'));
    set({ phase: 'loading', progress: 0, runtime: null });
    let t: WorkerTransport | null = null;
    try {
      const { dataset } = await loadHistory(settings.data, false, (progress) => set({ progress }));
      set({ phase: 'running', progress: 0 });
      t = new WorkerTransport();
      const res = await runScriptBacktest(
        compiled.project,
        t,
        dataset,
        {
          instrument: toStrategyInstrument(inst),
          startingBalance: 50_000,
          commissionPerUnit: settings.commissionPerUnit,
          takerFee: 0,
          slippageTicks: settings.slippageTicks,
          fillModel: 'tape',
        },
        {
          params: project.params,
          limits,
          dailyLoss: settings.dailyLoss,
          bars: barsSpec,
          sandbox: { ...DEFAULT_LIMITS, budgetMs: settings.budgetMs },
          onProgress: (progress) => set({ progress }),
        },
      );
      const e = res.error;
      set({
        phase: 'idle',
        progress: 1,
        result: res,
        rtab: e ? 'log' : 'summary',
        runtime: e
          ? {
              file: e.file ?? project.files[0]!.name,
              line: e.line ?? 1,
              column: e.column ?? 0,
              message: e.message,
              severity: 'error',
            }
          : null,
      });
      if (e) toast('error', tl('Strategy error'), e.message);
    } catch (err) {
      const e = err as { message?: string; line?: number; file?: string; column?: number };
      set({
        phase: 'idle',
        rtab: 'problems',
        runtime: {
          file: e.file ?? project.files[0]!.name,
          line: e.line ?? 1,
          column: e.column ?? 0,
          message: e.message ?? String(err),
          severity: 'error',
        },
      });
      toast('error', tl('Backtest failed'), e.message ?? String(err));
    } finally {
      t?.dispose();
    }
  };

  const startRun = async (mode: 'paper' | 'live', router?: LiveOrderRouter) => {
    if (!compiled.project) return toast('error', tl('Fix the errors first'));
    if (!inst) return;
    set({ rtab: 'runs' });
    const run = await scriptRuns.start({
      projectId: project.id,
      name: project.name,
      project: compiled.project,
      params: project.params,
      instrumentId: inst.id,
      bars: barsSpec,
      limits,
      budgetMs: settings.budgetMs,
      mode,
      router,
    });
    setLogRun(run.id);
    if (run.status === 'error') toast('error', tt`${project.name} could not start`, run.error);
    else
      toast('success', tt`${project.name} running (${mode})`, `${inst.symbol} · ${run.accountId}`);
  };

  const stopAll = () => {
    const n = scriptRuns.active().filter((r) => r.projectId === project.id).length;
    for (const r of scriptRuns.active()) if (r.projectId === project.id) scriptRuns.stop(r.id);
    toast('info', tt`${n} run(s) of ${project.name} stopped`);
  };

  const kill = () => {
    const n = scriptRuns.killAll() + liveRuns.list().length;
    liveRuns.stopAll(true);
    toast('info', tt`Kill switch: ${n} strategies stopped and flattened`);
  };

  const exportFile = () => {
    downloadText(
      `${project.name.replace(/[^\w-]+/g, '_') || 'strategy'}.htstrat`,
      serializeHtstrat(project),
    );
  };

  const importText = (text: string) => {
    try {
      const p = parseHtstrat(text);
      const clash = scripts.some((s) => s.id === p.id);
      const proj = clash ? { ...p, id: newProject().id } : p;
      saveProject(proj);
      open(proj);
      toast('success', tt`Imported ${proj.name}`);
    } catch (e) {
      toast('error', tl('Import failed'), e instanceof Error ? e.message : String(e));
    }
  };

  const actions: EditorActions = {
    newStrategy,
    backtest: () => void backtest(),
    paper: () => void startRun('paper'),
    stop: stopAll,
    save,
    importFile: () => fileInput.current?.click(),
    exportFile,
    open: (id) => {
      const p = projectById(id);
      if (p) open(p);
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const entry = {
      id: windowId,
      actions: new Proxy({} as EditorActions, {
        get: (_t, k: keyof EditorActions) => actionsRef.current[k],
      }),
    };
    editorMounted.push(entry);
    return () => {
      const i = editorMounted.indexOf(entry);
      if (i >= 0) editorMounted.splice(i, 1);
    };
  }, [windowId]);

  const updateFile = (source: string) =>
    setProject({
      ...project,
      files: project.files.map((f, i) => (i === file ? { ...f, source } : f)),
    });

  const addFile = () => {
    let k = 1;
    while (project.files.some((f) => f.name === `util${k}.ts`)) k++;
    const name = `util${k}.ts`;
    setProject({
      ...project,
      files: [
        ...project.files,
        {
          name,
          source: `// import { helper } from './util${k}';\nexport function helper(x: number) {\n  return x;\n}\n`,
        },
      ],
    });
    set({ file: project.files.length });
  };

  const renameFile = (i: number) => {
    const name = window.prompt(
      'File name (letters, digits, - or _; .ts or .js)',
      project.files[i]!.name,
    );
    if (!name || name === project.files[i]!.name) return;
    if (!validFileName(name) || project.files.some((f) => f.name === name))
      return toast('error', tl('Invalid or duplicate file name'));
    setProject({ ...project, files: project.files.map((f, j) => (j === i ? { ...f, name } : f)) });
  };

  const removeFile = (i: number) => {
    if (i === 0) return;
    setProject({ ...project, files: project.files.filter((_, j) => j !== i) });
    set({ file: 0 });
  };

  const res = state.result;
  const myRuns = scriptRuns.list();
  const range = rangeOf(settings.data);
  const busy = state.phase !== 'idle';

  return (
    <div className="hte" data-testid="ht-editor">
      <aside className="hte-side" aria-label={tl('My strategies')}>
        <div className="hte-side-head">
          <b>{tl('My strategies')}</b>
          <Button size="xs" variant="ghost" onClick={() => newStrategy()} data-testid="hte-new">
            {tl('New')}
          </Button>
        </div>
        <Select
          small
          aria-label={tl('Templates')}
          value=""
          options={[
            { value: '', label: 'New from template…' },
            ...SCRIPT_TEMPLATES.map((t) => ({ value: t.id, label: t.name })),
          ]}
          onChange={(v) => v && newStrategy(v)}
        />
        <ul className="hte-list">
          {scripts.map((s) => (
            <li key={s.id}>
              <button
                className="stg-item"
                aria-pressed={s.id === project.id}
                onClick={() => open(s)}
                data-testid={`hte-saved-${s.id}`}
              >
                <span className="stg-item-name">{s.name}</span>
                <span className="stg-item-cat">{new Date(s.updatedAt).toLocaleDateString()}</span>
              </button>
              <button
                className="hte-x"
                aria-label={tt`Delete ${s.name}`}
                onClick={() => {
                  if (window.confirm(`Delete ${s.name}?`)) deleteProject(s.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
          {!scripts.length && <li className="stg-muted">{tl('Nothing saved yet.')}</li>}
        </ul>
        <div className="hte-side-foot">
          <Button size="xs" variant="ghost" onClick={() => fileInput.current?.click()}>
            {tl('Import .htstrat')}
          </Button>
          <Button size="xs" variant="ghost" onClick={exportFile}>
            {tl('Export')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".htstrat,application/json"
            hidden
            data-testid="hte-import-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void f.text().then(importText);
            }}
          />
        </div>
      </aside>

      <section className="hte-main">
        <div className="hte-toolbar">
          <Input
            aria-label={tl('Strategy name')}
            className="hte-name"
            value={project.name}
            onChange={(e) => setProject({ ...project, name: e.target.value.slice(0, 80) })}
          />
          {dirty && <span className="stg-muted">{tl('unsaved')}</span>}
          <Button size="xs" onClick={save} data-testid="hte-save">
            {tl('Save')}
          </Button>
          <span className="grow" />
          <Badge kind={errors ? 'error' : 'default'}>
            {errors ? `${errors} error${errors > 1 ? 's' : ''}` : 'Compiled'}
          </Badge>
          <Button
            size="xs"
            variant="primary"
            disabled={busy}
            onClick={() => void backtest()}
            data-testid="hte-backtest"
          >
            {busy
              ? `${state.phase === 'loading' ? 'Loading' : 'Backtesting'} ${Math.round(state.progress * 100)}%`
              : 'Backtest'}
          </Button>
          <Button size="xs" onClick={() => void startRun('paper')} data-testid="hte-paper">
            {tl('Paper')}
          </Button>
          <Button size="xs" onClick={() => setArmOpen(true)} data-testid="hte-live">
            {tl('Live…')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              vpsDeployRequest.projectId = project.id;
              if (dirty) saveProject(project);
              onDeployVps();
            }}
            data-testid="hte-vps"
          >
            {tl('Deploy to my VPS')}
          </Button>
          <Button size="xs" variant="ghost" onClick={stopAll}>
            {tl('Stop')}
          </Button>
          <button
            className="hte-kill"
            onClick={kill}
            data-testid="hte-kill"
            title={tl('Stop every strategy and flatten')}
          >
            {tl('KILL')}
          </button>
        </div>
        <div className="hte-files" role="tablist" aria-label={tl('Files')}>
          {project.files.map((f, i) => (
            <button
              key={f.name}
              role="tab"
              aria-selected={i === file}
              className="hte-file"
              onClick={() => set({ file: i })}
              onDoubleClick={() => renameFile(i)}
              title={tl('Double-click to rename')}
            >
              {f.name}
              {i > 0 && (
                <span
                  className="hte-x"
                  role="button"
                  aria-label={tt`Close ${f.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(i);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button className="hte-file" onClick={addFile} aria-label={tl('Add file')}>
            +
          </button>
        </div>
        <div className="hte-editor">
          <CodeEditor
            value={cur.source}
            onChange={updateFile}
            docKey={`${project.id}/${cur.name}`}
            diagnostics={diagnostics.filter((d) => d.file === cur.name)}
          />
        </div>
        <div className="hte-results">
          <Tabs
            value={state.rtab}
            onChange={(rtab) => set({ rtab })}
            tabs={[
              { value: 'problems', label: `Problems (${diagnostics.length})` },
              { value: 'summary', label: 'Summary' },
              { value: 'equity', label: 'Equity' },
              { value: 'plots', label: 'Plots' },
              { value: 'trades', label: `Trades${res ? ` (${res.result.trades.length})` : ''}` },
              { value: 'log', label: 'Log' },
              { value: 'runs', label: `Runs (${scriptRuns.active().length})` },
            ]}
          />
          <div className="hte-result-body">
            {state.rtab === 'problems' ? (
              <ul className="hte-problems" data-testid="hte-problems">
                {diagnostics.map((d, i) => (
                  <li key={i} className={d.severity}>
                    <button
                      onClick={() =>
                        set({
                          file: Math.max(
                            0,
                            project.files.findIndex((f) => f.name === d.file),
                          ),
                        })
                      }
                    >
                      {d.file}:{d.line}:{d.column + 1}
                    </button>{' '}
                    {d.message}
                  </li>
                ))}
                {!diagnostics.length && <li className="stg-muted">{tl('No problems.')}</li>}
              </ul>
            ) : state.rtab === 'runs' ? (
              <RunsPanel runs={myRuns} logRun={logRun} setLogRun={setLogRun} />
            ) : !res ? (
              <p className="stg-muted">{tl('Run a backtest to see results.')}</p>
            ) : state.rtab === 'summary' ? (
              <Summary r={res.result} />
            ) : state.rtab === 'equity' ? (
              <div className="stg-chart">
                <EquityCanvas result={res.result} style={DEFAULT_STYLE} />
              </div>
            ) : state.rtab === 'plots' ? (
              <div className="stg-chart">
                <PlotCanvas res={res} />
              </div>
            ) : state.rtab === 'trades' ? (
              <div data-testid="hte-trades">
                <TradesTable r={res.result} />
              </div>
            ) : (
              <pre className="stg-log" data-testid="hte-log">
                {res.logs.length
                  ? res.logs
                      .map(
                        (l) =>
                          `${fmtTime(l.ts)}  ${l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.text}`,
                      )
                      .join('\n')
                  : 'No log lines.'}
                {`\n\n${res.calls} sandbox calls, slowest ${res.maxCallMs.toFixed(1)} ms`}
              </pre>
            )}
          </div>
        </div>
      </section>

      <aside className="hte-settings" aria-label={tl('Strategy settings')}>
        <div className="stg-subhead">{tl('Parameters')}</div>
        {desc ? (
          Object.keys(defs).length ? (
            <InputsForm
              defs={defs}
              values={project.params as RawInputs}
              onChange={(v) => setProject({ ...project, params: v as StrategyProject['params'] })}
              testId="hte-params"
            />
          ) : (
            <p className="stg-muted">{tl('No params exported.')}</p>
          )
        ) : (
          <p className="stg-muted">
            {compiled.project ? 'Reading the strategy…' : 'Fix the errors to see the parameters.'}
          </p>
        )}
        <div className="stg-subhead">{tl('Data')}</div>
        <div className="stg-inputs">
          <label className="stg-input-row">
            <span>{tl('Instrument')}</span>
            <Select
              small
              aria-label={tl('Instrument')}
              value={settings.data.instrumentId}
              options={instruments.map((i) => ({
                value: i.id,
                label: `${i.symbol} · ${i.exchange}`,
              }))}
              onChange={(instrumentId) =>
                setSettings({ data: { ...settings.data, instrumentId, source: '' } })
              }
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Day (UTC)')}</span>
            <input
              type="date"
              className="ht-input"
              aria-label={tl('Day')}
              value={settings.data.day || new Date(range.from).toISOString().slice(0, 10)}
              onChange={(e) => setSettings({ data: { ...settings.data, day: e.target.value } })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('From hour')}</span>
            <NumberInput
              aria-label={tl('From hour')}
              value={settings.data.fromHour}
              min={0}
              max={23}
              unit="UTC"
              onChange={(fromHour) => setSettings({ data: { ...settings.data, fromHour } })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Length')}</span>
            <NumberInput
              aria-label={tl('Hours')}
              value={settings.data.hours}
              min={1}
              max={720}
              unit="h"
              onChange={(hours) => setSettings({ data: { ...settings.data, hours } })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Bars')}</span>
            <Select
              small
              aria-label={tl('Bars')}
              value={settings.bars}
              options={[
                { value: '', label: `Script (${desc?.timeframe ?? '5m'})` },
                ...BAR_SPECS.map((b) => ({ value: b.value, label: b.label })),
              ]}
              onChange={(bars) => setSettings({ bars })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Commission')}</span>
            <NumberInput
              aria-label={tl('Commission per side')}
              value={settings.commissionPerUnit}
              min={0}
              max={1000}
              step={0.25}
              unit="$/side"
              onChange={(commissionPerUnit) => setSettings({ commissionPerUnit })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Slippage')}</span>
            <NumberInput
              aria-label={tl('Slippage')}
              value={settings.slippageTicks}
              min={0}
              max={100}
              unit="ticks"
              onChange={(slippageTicks) => setSettings({ slippageTicks })}
            />
          </label>
        </div>
        <div className="stg-subhead">{tl('Risk limits')}</div>
        <div className="stg-inputs">
          <label className="stg-input-row">
            <span>{tl('Max order qty')}</span>
            <NumberInput
              aria-label={tl('Max order quantity')}
              value={settings.maxOrderQty}
              min={0.0001}
              max={1e6}
              onChange={(maxOrderQty) => setSettings({ maxOrderQty })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Max position')}</span>
            <NumberInput
              aria-label={tl('Max position')}
              value={settings.maxPosition}
              min={0.0001}
              max={1e6}
              onChange={(maxPosition) => setSettings({ maxPosition })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('Daily loss')}</span>
            <NumberInput
              aria-label={tl('Daily loss limit')}
              value={settings.dailyLoss}
              min={0}
              max={1e9}
              unit="$"
              onChange={(dailyLoss) => setSettings({ dailyLoss })}
            />
          </label>
          <label className="stg-input-row">
            <span>{tl('CPU budget')}</span>
            <NumberInput
              aria-label={tl('CPU budget per callback')}
              value={settings.budgetMs}
              min={10}
              max={5000}
              unit="ms"
              onChange={(budgetMs) => setSettings({ budgetMs })}
            />
          </label>
        </div>
        <p className="stg-muted">
          Paper and live runs also pass the account&apos;s risk rules (Risk module). Daily loss
          applies to backtests through the same risk engine.
        </p>
      </aside>
      {armOpen && (
        <ArmDialog
          symbol={inst?.symbol ?? ''}
          instrumentId={inst?.id ?? ''}
          settings={settings}
          onClose={() => setArmOpen(false)}
          onArm={(r) => {
            setArmOpen(false);
            void startRun('live', r);
          }}
        />
      )}
    </div>
  );
}

function RunsPanel({
  runs,
  logRun,
  setLogRun,
}: {
  runs: ScriptRun[];
  logRun: string | null;
  setLogRun(id: string | null): void;
}) {
  const sel = runs.find((r) => r.id === logRun) ?? runs[0];
  return (
    <div className="hte-runs" data-testid="hte-runs">
      <Table<ScriptRun>
        aria-label={tl('Strategy runs')}
        height={150}
        rows={runs}
        rowId={(r) => r.id}
        empty={tl('No strategy runs. Use Paper or Live… to start one.')}
        onRowActivate={(r) => setLogRun(r.id)}
        columns={[
          { key: 'name', header: 'Strategy', width: 140, render: (r) => r.name },
          {
            key: 'mode',
            header: 'Mode',
            width: 60,
            render: (r) => (r.mode === 'live' ? <b className="down">{tl('LIVE')}</b> : 'Paper'),
          },
          {
            key: 'inst',
            header: 'Instrument',
            width: 100,
            render: (r) => instrumentById(r.instrumentId)?.symbol ?? r.instrumentId,
          },
          {
            key: 'status',
            header: 'Status',
            width: 80,
            render: (r) => (
              <span
                className={r.status === 'error' ? 'down' : r.status === 'running' ? 'up' : ''}
                title={r.error}
              >
                {r.status}
              </span>
            ),
          },
          {
            key: 'pos',
            header: 'Pos',
            width: 50,
            numeric: true,
            render: (r) => runStats(r).position,
          },
          {
            key: 'trades',
            header: 'Trades',
            width: 56,
            numeric: true,
            render: (r) => runStats(r).trades,
          },
          {
            key: 'net',
            header: 'Net',
            width: 80,
            numeric: true,
            render: (r) => {
              const n = runStats(r).net;
              return <span className={tone(n)}>{signedMoney(n, 2)}</span>;
            },
          },
          {
            key: 'act',
            header: '',
            width: 120,
            render: (r) => (
              <span className="stg-row-actions">
                {r.status === 'running' || r.status === 'starting' ? (
                  <Button size="xs" variant="secondary" onClick={() => scriptRuns.stop(r.id)}>
                    {tl('Stop')}
                  </Button>
                ) : (
                  <Button size="xs" variant="ghost" onClick={() => scriptRuns.remove(r.id)}>
                    {tl('Remove')}
                  </Button>
                )}
                <Button size="xs" variant="ghost" onClick={() => setLogRun(r.id)}>
                  {tl('Logs')}
                </Button>
              </span>
            ),
          },
        ]}
      />
      {sel && (
        <pre className="stg-log" data-testid="hte-run-log">
          {sel.error ? `ERROR ${sel.error}\n` : ''}
          {sel.logs.length
            ? sel.logs
                .slice(-300)
                .map((l) => `${fmtTime(l.ts || sel.startedAt)}  ${l.text}`)
                .join('\n')
            : 'No log lines yet.'}
        </pre>
      )}
    </div>
  );
}

/** Script plots on a price axis, with the backtest's entries (▲ ▼) and exits (●). */
function PlotCanvas({ res }: { res: ScriptBacktestResult }) {
  const ref = useCanvas(
    (g, w, h) => {
      const text = cssVar('--ht-text-tertiary', '#838383');
      const pad = { l: 8, r: 70, t: 10, b: 18 };
      const pts = res.plots.filter((p) => p.overlay);
      const trades = res.result.trades;
      const tick = res.result.config.instrument.tickSize;
      if (!pts.length && !trades.length) {
        g.fillStyle = text;
        g.fillText('No overlay plots (use plot(name, value)).', pad.l, h / 2);
        return;
      }
      const ys = [
        ...pts.map((p) => p.value),
        ...trades.flatMap((t) => [t.entryPx * tick, t.exitPx * tick]),
      ];
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const t0 = res.result.from;
      const t1 = Math.max(res.result.to, t0 + 1);
      const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
      const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
      const palette = ['#4fc3f7', '#ffb74d', '#ab47bc', '#66bb6a', '#ef5350', '#ffd54f'];
      const byName = new Map<string, typeof pts>();
      for (const p of pts) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
      let k = 0;
      g.font = '10px Geist, sans-serif';
      for (const [name, list] of byName) {
        const color = list[0]!.color ?? palette[k % palette.length]!;
        g.strokeStyle = color;
        g.lineWidth = 1.2;
        g.beginPath();
        list.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.value)) : g.moveTo(x(p.t), y(p.value))));
        g.stroke();
        g.fillStyle = color;
        g.fillText(name, w - pad.r + 6, pad.t + 12 * k + 6);
        k++;
      }
      for (const t of trades) {
        g.fillStyle = t.side === 'long' ? '#20C77A' : '#F04A5D';
        const ex = x(t.entryTs);
        const ey = y(t.entryPx * tick);
        g.beginPath();
        if (t.side === 'long') {
          g.moveTo(ex, ey - 5);
          g.lineTo(ex - 4, ey + 3);
          g.lineTo(ex + 4, ey + 3);
        } else {
          g.moveTo(ex, ey + 5);
          g.lineTo(ex - 4, ey - 3);
          g.lineTo(ex + 4, ey - 3);
        }
        g.fill();
        g.beginPath();
        g.arc(x(t.exitTs), y(t.exitPx * tick), 2.5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = text;
      g.fillText(hi.toFixed(2), w - pad.r + 6, h - pad.b - 14);
      g.fillText(lo.toFixed(2), w - pad.r + 6, h - pad.b);
    },
    [res],
  );
  return (
    <canvas
      ref={ref}
      className="stg-canvas"
      aria-label={tl('Strategy plots')}
      data-testid="hte-plots"
    />
  );
}

function ArmDialog({
  symbol,
  instrumentId,
  settings,
  onClose,
  onArm,
}: {
  symbol: string;
  instrumentId: string;
  settings: EditorSettings;
  onClose(): void;
  onArm(r: LiveOrderRouter): void;
}) {
  const routers = liveRouters().filter((r) => r.instruments().includes(instrumentId));
  const [routerId, setRouter] = useState(routers[0]?.id ?? '');
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const router = routers.find((r) => r.id === routerId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={tl('Arm live trading')} width={440}>
      <div className="stg-form" data-testid="hte-arm-dialog">
        <div className="stg-banner" role="note">
          <b>{tl('Real orders.')}</b>{' '}
          {tl(
            'The strategy will send orders to your broker / exchange account. Every order is validated, then checked by the risk engine. The KILL button stops every strategy and flattens.',
          )}
        </div>
        {routers.length === 0 ? (
          <p className="down" data-testid="hte-no-live">
            {tl('No connected account supports live order routing for')}{' '}
            {symbol || 'this instrument'}{' '}
            {tl(
              'yet. Live trading needs a broker / exchange trading connector (see BLOCKERS). Use Paper.',
            )}
          </p>
        ) : (
          <>
            <label className="stg-input-row">
              <span>{tl('Account')}</span>
              <Select
                small
                value={routerId}
                options={routers.map((r) => ({ value: r.id, label: r.label }))}
                onChange={setRouter}
              />
            </label>
            <ul className="tnum">
              <li>
                {tl('Max order qty:')} {settings.maxOrderQty}
              </li>
              <li>
                {tl('Max position:')} {settings.maxPosition}
              </li>
              <li>{tl('Daily loss limit (account rules): see the Risk module')}</li>
              <li>
                {tl('CPU budget per callback:')} {settings.budgetMs} {tl('ms')}
              </li>
            </ul>
            <label className="stg-input-row">
              <span>
                {tl('Type')} {symbol} {tl('to arm')}
              </span>
              <Input
                aria-label={tl('Confirm symbol')}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
            <Checkbox
              checked={ack}
              onChange={setAck}
              label={tl('I understand this strategy trades real money')}
            />
          </>
        )}
        <div className="stg-dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {tl('Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!router || !ack || typed.trim() !== symbol}
            onClick={() => router && onArm(router)}
            data-testid="hte-arm-go"
          >
            {tl('Arm and start')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
