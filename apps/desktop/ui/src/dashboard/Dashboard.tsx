import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
} from 'dockview';
import {
  ArrowDownToLine,
  ArrowRightToLine,
  Columns2,
  ExternalLink,
  Grid2x2,
  Layout,
  PanelRight,
  Plus,
  Square,
  X,
} from 'lucide-react';
import {
  Button,
  Chip,
  Dialog,
  DropdownMenu,
  Field,
  Input,
  LogoBars,
  SegmentedControl,
  toast,
  type MenuEntry,
} from '@htflow/ui-kit';
import { FOOTPRINT_MODES } from '@htflow/footprint';
import {
  CHART_TEMPLATES,
  chartState,
  domState,
  LAYOUT_PRESETS,
  windowTitle,
  type ChartTemplateId,
  type LayoutPresetId,
  type WindowState,
  type WorkspaceDoc,
  type WorkspaceTab,
} from '@htflow/workspace';
import { backend, BackendError } from '../backend';
import { useSession } from '../state/session';
import { activeInstrument, useWindows } from '../state/windows';
import { DEFAULT_INSTRUMENT, allInstruments, instrumentById } from '../state/instruments';
import { paper, PAPER_ACCOUNT } from '../state/market';
import { isTauri } from '../backend';
import { TitleBar } from '../shell/TitleBar';
import { Ribbon } from '../shell/Ribbon';
import { StatusBar } from '../shell/StatusBar';
import { CommandPalette } from '../shell/CommandPalette';
import { installHotkeys, registerCommands, type Command } from '../shell/commands';
import { MODULES } from '../shell/modules';
import { ChartWindow } from '../charts/ChartWindow';
import { DomWindow } from '../trading/DomView';
import { TradingPanel } from '../trading/TradingPanel';
import { ModuleWindow } from './ModuleWindow';
import { WindowHeader } from './WindowHeader';

const theme: DockviewTheme = { name: 'htflow', className: 'dockview-theme-htflow', gap: 4 };
const components = { chart: ChartWindow, dom: DomWindow, module: ModuleWindow };

const PRESET_ICONS: Record<LayoutPresetId, JSX.Element> = {
  'dom-chart-panel': <Columns2 size={14} />,
  grid: <Grid2x2 size={14} />,
  'one-plus-two': <Layout size={14} />,
  split: <Columns2 size={14} />,
  single: <Square size={13} />,
};

let seq = 0;
const newId = (kind: string) => `${kind}-${Date.now().toString(36)}${(seq++).toString(36)}`;

function title(s: WindowState) {
  return windowTitle(s, s.kind !== 'module' ? (instrumentById(s.instrumentId)?.symbol ?? '') : '');
}

export function Dashboard({ version }: { version: string }) {
  const session = useSession((s) => s.session)!;
  const apiRef = useRef<DockviewApi | null>(null);
  const [doc, setDoc] = useState<WorkspaceDoc>({
    version: 1,
    name: 'Crypto + Futures',
    activeTab: '',
    tabs: [],
    savedAt: 0,
  });
  const docRef = useRef(doc);
  docRef.current = doc;
  const [preset, setPreset] = useState<LayoutPresetId>('dom-chart-panel');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [ribbonCompact, setRibbonCompact] = useState(false);
  const tradingPanel = useWindows((s) => s.tradingPanel);
  const windows = useWindows((s) => s.windows);
  const loading = useRef(false);

  // ------------------------------------------------------------- layout helpers

  const addPanel = useCallback(
    (
      id: string,
      state: WindowState,
      position?: { ref: string; dir: 'right' | 'below' | 'left' | 'above' | 'within' },
    ) => {
      const api = apiRef.current;
      if (!api) return;
      useWindows.getState().add(id, state);
      const ref = position && api.getPanel(position.ref);
      api.addPanel({
        id,
        component: state.kind,
        title: title(state),
        position: ref ? { referencePanel: ref, direction: position!.dir } : undefined,
      });
    },
    [],
  );

  const snapshotTab = (): WorkspaceTab | null => {
    const api = apiRef.current;
    const d = docRef.current;
    const cur = d.tabs.find((t) => t.id === d.activeTab);
    if (!api || !cur) return null;
    return {
      ...cur,
      layout: api.toJSON(),
      windows: useWindows.getState().windows,
      tradingPanel: useWindows.getState().tradingPanel,
    };
  };

  const save = useCallback(() => {
    if (loading.current) return;
    const t = snapshotTab();
    if (!t) return;
    const d = docRef.current;
    const next: WorkspaceDoc = {
      ...d,
      tabs: d.tabs.map((x) => (x.id === t.id ? t : x)),
      savedAt: Date.now(),
    };
    docRef.current = next;
    setDoc(next);
    void backend.saveSettings('workspace', next);
  }, []);

  const applyPreset = useCallback(
    (id: LayoutPresetId, instrumentId = activeInstrument() ?? DEFAULT_INSTRUMENT) => {
      const api = apiRef.current;
      if (!api) return;
      const p = LAYOUT_PRESETS.find((x) => x.id === id)!;
      loading.current = true;
      api.clear();
      useWindows.getState().setAll({});
      const specs = p.build(instrumentId);
      for (const s of specs) addPanel(s.id, s.state, s.position);
      // Initial split sizes (editable afterwards by dragging splitters).
      for (const s of specs) {
        if (!s.size || !s.position) continue;
        const panel = api.getPanel(s.id);
        const total = api.width;
        if (panel && (s.position.dir === 'right' || s.position.dir === 'left'))
          panel.api.setSize({ width: Math.round(total * s.size) });
      }
      useWindows.getState().setTradingPanel(p.tradingPanel);
      setPreset(id);
      loading.current = false;
      save();
    },
    [addPanel, save],
  );

  const restoreTab = useCallback(
    (tab: WorkspaceTab) => {
      const api = apiRef.current;
      if (!api) return;
      loading.current = true;
      try {
        useWindows.getState().setAll(tab.windows);
        api.clear();
        if (tab.layout) api.fromJSON(tab.layout as Parameters<DockviewApi['fromJSON']>[0]);
        useWindows.getState().setTradingPanel(tab.tradingPanel);
      } catch (e) {
        console.warn('Workspace restore failed, applying default preset', e);
        loading.current = false;
        applyPreset('dom-chart-panel');
      }
      loading.current = false;
    },
    [applyPreset],
  );

  const onReady = useCallback(
    (e: DockviewReadyEvent) => {
      apiRef.current = e.api;
      e.api.onDidRemovePanel((p) => {
        if (!loading.current) useWindows.getState().remove(p.id);
      });
      e.api.onDidActivePanelChange((p) => p && useWindows.getState().setActive(p.id));
      let timer: ReturnType<typeof setTimeout> | null = null;
      e.api.onDidLayoutChange(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 800);
      });
      void backend.loadSettings<WorkspaceDoc>('workspace').then((saved) => {
        if (saved && saved.tabs?.length) {
          docRef.current = saved;
          setDoc(saved);
          restoreTab(saved.tabs.find((t) => t.id === saved.activeTab) ?? saved.tabs[0]!);
        } else {
          const tab: WorkspaceTab = {
            id: newId('tab'),
            name: 'DOM + Footprint',
            layout: null,
            windows: {},
            tradingPanel: true,
          };
          const d: WorkspaceDoc = {
            version: 1,
            name: 'Crypto + Futures',
            activeTab: tab.id,
            tabs: [tab],
            savedAt: 0,
          };
          docRef.current = d;
          setDoc(d);
          applyPreset('dom-chart-panel', DEFAULT_INSTRUMENT);
        }
      });
    },
    [applyPreset, restoreTab, save],
  );

  // Persist on window-state changes and every 60 s (P25 autosave).
  useEffect(() => {
    const t = setTimeout(save, 500);
    return () => clearTimeout(t);
  }, [windows, tradingPanel, save]);
  useEffect(() => {
    const i = setInterval(save, 60_000);
    return () => clearInterval(i);
  }, [save]);

  // Keep dockview tab titles in sync with window state.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const [id, s] of Object.entries(windows)) api.getPanel(id)?.api.setTitle(title(s));
  }, [windows]);

  const switchTab = (id: string) => {
    const cur = snapshotTab();
    const d = docRef.current;
    const tabs = cur ? d.tabs.map((t) => (t.id === cur.id ? cur : t)) : d.tabs;
    const next = { ...d, tabs, activeTab: id };
    docRef.current = next;
    setDoc(next);
    const target = tabs.find((t) => t.id === id)!;
    if (target.layout) restoreTab(target);
    else applyPreset('single');
    void backend.saveSettings('workspace', next);
  };

  const addTab = () => {
    const cur = snapshotTab();
    const d = docRef.current;
    const tab: WorkspaceTab = {
      id: newId('tab'),
      name: `Layout ${d.tabs.length + 1}`,
      layout: null,
      windows: {},
      tradingPanel: false,
    };
    const next = {
      ...d,
      tabs: [...(cur ? d.tabs.map((t) => (t.id === cur.id ? cur : t)) : d.tabs), tab],
      activeTab: tab.id,
    };
    docRef.current = next;
    setDoc(next);
    applyPreset('single');
  };

  const closeTab = (id: string) => {
    const d = docRef.current;
    if (d.tabs.length < 2) return;
    const tabs = d.tabs.filter((t) => t.id !== id);
    const next = { ...d, tabs, activeTab: d.activeTab === id ? tabs[0]!.id : d.activeTab };
    docRef.current = next;
    setDoc(next);
    if (d.activeTab === id) restoreTab(tabs[0]!);
    void backend.saveSettings('workspace', next);
  };

  const renameTab = (id: string) => {
    const name = window.prompt('Layout name', docRef.current.tabs.find((t) => t.id === id)?.name);
    if (!name) return;
    const next = {
      ...docRef.current,
      tabs: docRef.current.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
    };
    docRef.current = next;
    setDoc(next);
    void backend.saveSettings('workspace', next);
  };

  const openWindow = useCallback(
    (state: WindowState) => {
      const api = apiRef.current;
      if (!api) return;
      const active = api.activePanel;
      addPanel(newId(state.kind), state, active ? { ref: active.id, dir: 'within' } : undefined);
    },
    [addPanel],
  );

  const split = useCallback(
    (dir: 'right' | 'below') => {
      const api = apiRef.current;
      const active = api?.activePanel;
      if (!api || !active) return;
      const s = useWindows.getState().windows[active.id];
      if (!s) return;
      addPanel(newId(s.kind), { ...s }, { ref: active.id, dir });
    },
    [addPanel],
  );

  const detach = useCallback(() => {
    const api = apiRef.current;
    const active = api?.activePanel;
    if (!api || !active) return;
    api.addFloatingGroup(active, { position: { left: 120, top: 80 }, width: 820, height: 520 });
  }, []);

  const setMainChart = (tpl: ChartTemplateId) => {
    const api = apiRef.current;
    const first = Object.entries(useWindows.getState().windows).find(([, s]) => s.kind === 'chart');
    if (!api || !first) return;
    useWindows.getState().patch(first[0], { template: tpl } as Partial<WindowState>);
  };

  // ------------------------------------------------------------- commands

  useEffect(() => {
    const inst = () => activeInstrument() ?? DEFAULT_INSTRUMENT;
    const cmds: Command[] = [
      {
        id: 'palette',
        label: 'Command palette',
        group: 'Platform',
        shortcut: 'Ctrl+K',
        run: () => setPaletteOpen((x) => !x),
      },
      {
        id: 'trading-panel',
        label: 'Toggle Trading Panel',
        group: 'Trading',
        shortcut: 'T',
        run: () => useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel),
      },
      {
        id: 'lock',
        label: 'Lock HT Flow',
        group: 'Platform',
        shortcut: 'Ctrl+L',
        run: () => void useSession.getState().lock(),
      },
      { id: 'split-right', label: 'Split right', group: 'Layout', run: () => split('right') },
      { id: 'split-down', label: 'Split down', group: 'Layout', run: () => split('below') },
      { id: 'detach', label: 'Detach window (floating)', group: 'Layout', run: detach },
      {
        id: 'ribbon-compact',
        label: 'Ribbon: icons only',
        group: 'Layout',
        run: () => setRibbonCompact((x) => !x),
      },
      {
        id: 'flatten-all',
        label: 'Flatten all positions (paper)',
        group: 'Trading',
        run: () => paper.flattenAll(PAPER_ACCOUNT),
      },
      {
        id: 'breakeven',
        label: 'Breakeven',
        group: 'Trading',
        shortcut: 'H',
        run: () => paper.breakeven(PAPER_ACCOUNT, inst()),
      },
      ...LAYOUT_PRESETS.map((p) => ({
        id: `layout.${p.id}`,
        label: `Layout: ${p.label}`,
        group: 'Layout' as const,
        run: () => applyPreset(p.id),
      })),
      ...CHART_TEMPLATES.map((t) => ({
        id: `chart.${t.id}`,
        label: `New chart: ${t.label}`,
        group: 'Chart' as const,
        run: () => openWindow(chartState(inst(), t.id)),
      })),
      ...FOOTPRINT_MODES.filter((m) => m.shortcut).map((m) => ({
        id: `fp.${m.id}`,
        label: `Footprint: ${m.label}`,
        group: 'Chart' as const,
        shortcut: m.shortcut,
        run: () => {
          const { activeId, windows: w, patch } = useWindows.getState();
          const target =
            activeId && w[activeId]?.kind === 'chart'
              ? activeId
              : Object.keys(w).find((k) => w[k]!.kind === 'chart');
          if (target)
            patch(target, { footprintMode: m.id, template: 'footprint' } as Partial<WindowState>);
        },
      })),
      ...allInstruments(isTauri).map((i) => ({
        id: `inst.${i.id}`,
        label: `${i.symbol} — ${i.exchange}`,
        group: 'Instrument' as const,
        keywords: i.displayName,
        run: () => {
          const { activeId, patch } = useWindows.getState();
          if (activeId) patch(activeId, { instrumentId: i.id } as Partial<WindowState>);
          else openWindow(chartState(i.id, 'footprint'));
        },
      })),
      ...MODULES.map((m) => ({
        id: `open.${m.id}`,
        label: `Open ${m.label}`,
        group: 'Analysis' as const,
        run: () => {
          if (m.id === 'chart') openWindow(chartState(inst(), 'footprint'));
          else if (m.id === 'smart-dom') openWindow(domState(inst()));
          else if (m.id === 'heatmap') openWindow(chartState(inst(), 'liquidity-map'));
          else openWindow({ kind: 'module', module: m.id });
        },
      })),
    ];
    const un = registerCommands(cmds);
    const unk = installHotkeys();
    return () => {
      un();
      unk();
    };
  }, [applyPreset, openWindow, split, detach]);

  // Auto-lock after idle (P03 setting; default 30 min).
  useEffect(() => {
    let last = Date.now();
    const bump = () => (last = Date.now());
    window.addEventListener('mousemove', bump);
    window.addEventListener('keydown', bump);
    const i = setInterval(() => {
      if (Date.now() - last > 30 * 60_000) void useSession.getState().lock();
    }, 15_000);
    return () => {
      window.removeEventListener('mousemove', bump);
      window.removeEventListener('keydown', bump);
      clearInterval(i);
    };
  }, []);

  const singleChart = preset === 'single';
  const firstChart = Object.values(windows).find((w) => w.kind === 'chart');

  return (
    <div className="app-root">
      <TitleBar>
        <div className="titlebar-brand">
          <LogoBars size={16} />
          <span className="tb-logo">
            HT
            <br />
            FLOW
          </span>
        </div>
        <DropdownMenu
          items={[
            { kind: 'label', id: 'l', label: 'Workspace' },
            {
              id: 'r',
              label: `Rename "${doc.name}"…`,
              onSelect: () => {
                const n = window.prompt('Workspace name', doc.name);
                if (n) {
                  const next = { ...docRef.current, name: n };
                  docRef.current = next;
                  setDoc(next);
                  void backend.saveSettings('workspace', next);
                }
              },
            },
            {
              id: 'reset',
              label: 'Reset to default layout',
              onSelect: () => applyPreset('dom-chart-panel'),
            },
            { kind: 'separator', id: 's' },
            { id: 'more', label: 'Workspaces manager (P37)', disabled: true },
          ]}
          trigger={
            <button className="tb-workspace">
              <span className="muted">Workspace:</span> {doc.name} ▾
            </button>
          }
        />
        <div className="tb-group">
          <span className="muted">Layout</span>
          <SegmentedControl
            aria-label="Layout presets"
            value={preset}
            onChange={(v) => applyPreset(v)}
            options={LAYOUT_PRESETS.map((p) => ({
              value: p.id,
              label: (
                <>
                  {PRESET_ICONS[p.id]} {p.label}
                </>
              ),
              title: p.label,
            }))}
          />
        </div>
        {singleChart && firstChart?.kind === 'chart' && (
          <div className="tb-group">
            <span className="muted">Main chart</span>
            {CHART_TEMPLATES.map((t) => (
              <Chip
                key={t.id}
                selected={firstChart.template === t.id}
                onClick={() => setMainChart(t.id)}
              >
                {t.short}
              </Chip>
            ))}
          </div>
        )}
        <div className="tb-group">
          <Button size="xs" variant="ghost" onClick={() => split('right')}>
            <ArrowRightToLine size={13} /> Split right
          </Button>
          <Button size="xs" variant="ghost" onClick={() => split('below')}>
            <ArrowDownToLine size={13} /> Split down
          </Button>
          <Button size="xs" variant="ghost" onClick={detach}>
            <ExternalLink size={13} /> Detach window
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={tradingPanel}
            onClick={() => useWindows.getState().setTradingPanel(!tradingPanel)}
          >
            <PanelRight size={13} /> Panel
          </Button>
        </div>
        <RiskMeter />
        <AccountMenu name={session.displayName} />
      </TitleBar>
      <Ribbon compact={ribbonCompact} />
      <div className="workspace-row">
        <div className="dock-host">
          <DockviewReact
            components={components}
            defaultTabComponent={WindowHeader}
            onReady={onReady}
            theme={theme}
            singleTabMode="fullwidth"
          />
        </div>
        {tradingPanel && <TradingPanel />}
      </div>
      <div className="ws-tabs" role="tablist" aria-label="Workspace layouts">
        {doc.tabs.map((t) => (
          <div
            key={t.id}
            className="ws-tab"
            role="tab"
            aria-selected={t.id === doc.activeTab}
            onClick={() => t.id !== doc.activeTab && switchTab(t.id)}
            onDoubleClick={() => renameTab(t.id)}
          >
            {t.name}
            {doc.tabs.length > 1 && (
              <button
                className="ws-tab-x"
                aria-label={`Close ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button className="ws-tab ws-tab-add" aria-label="Add layout" onClick={addTab}>
          <Plus size={13} />
        </button>
      </div>
      <StatusBar version={version} timezone={session.timezone} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/** Daily risk meter in the title bar (full Risk Management in P23/P41). */
function RiskMeter() {
  const [, set] = useState(0);
  useEffect(() => paper.subscribe(() => set((x) => x + 1)), []);
  const acc = paper.accounts.get(PAPER_ACCOUNT)!;
  const limit = 1000;
  const loss = Math.max(0, acc.startingBalance - acc.balance);
  const pct = Math.min(1, loss / limit);
  return (
    <div className="tb-risk" title={`Daily loss ${loss.toFixed(2)} of ${limit} limit (paper)`}>
      <span className="muted">Daily risk</span>
      <div className="risk-meter">
        <span
          style={{
            width: `${Math.max(4, pct * 100)}%`,
            background:
              pct > 0.8 ? 'var(--ht-down)' : pct > 0.5 ? 'var(--ht-warning)' : 'var(--ht-up)',
          }}
        />
      </div>
    </div>
  );
}

function AccountMenu({ name }: { name: string }) {
  const [pwOpen, setPwOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const download = async () => {
    try {
      const text = await backend.exportProfile();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `${useSession.getState().session?.username ?? 'profile'}.htprofile`;
      a.click();
      toast(
        'success',
        'Profile exported',
        'The .htprofile file stays encrypted with your password.',
      );
    } catch (e) {
      toast('error', 'Export failed', e instanceof Error ? e.message : String(e));
    }
  };
  const items: MenuEntry[] = [
    { kind: 'label', id: 'n', label: name },
    { id: 'pw', label: 'Change password…', onSelect: () => setPwOpen(true) },
    { id: 'pin', label: 'Change PIN…', onSelect: () => setPinOpen(true) },
    { id: 'export', label: 'Export profile (.htprofile)', onSelect: () => void download() },
    { kind: 'separator', id: 's' },
    { id: 'switch', label: 'Switch user', onSelect: () => void useSession.getState().logout() },
    {
      id: 'lock',
      label: 'Lock',
      shortcut: 'Ctrl+L',
      onSelect: () => void useSession.getState().lock(),
    },
    { id: 'logout', label: 'Log out', onSelect: () => void useSession.getState().logout() },
  ];
  return (
    <>
      <DropdownMenu
        align="end"
        items={items}
        trigger={
          <button className="avatar" aria-label="Account menu" data-testid="account-menu">
            {name.slice(0, 1).toUpperCase()}
          </button>
        }
      />
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <PinDialog open={pinOpen} onOpenChange={setPinOpen} />
    </>
  );
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Change password" width={400}>
      <form
        className="col gap12"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await backend.changePassword(a, b);
            toast('success', 'Password changed');
            onOpenChange(false);
          } catch (x) {
            setErr(x instanceof BackendError ? x.message : String(x));
          }
        }}
      >
        <Field label="Current password">
          <Input type="password" value={a} onChange={(e) => setA(e.target.value)} />
        </Field>
        <Field label="New password (min 10)" error={err}>
          <Input type="password" value={b} onChange={(e) => setB(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={b.length < 10}>
          Change password
        </Button>
      </form>
    </Dialog>
  );
}

function PinDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [pin, setPin] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick-unlock PIN"
      description="6 digits. Leave empty to remove the PIN."
      width={380}
    >
      <form
        className="col gap12"
        onSubmit={async (e) => {
          e.preventDefault();
          await backend.setPin(pin || null);
          toast('success', pin ? 'PIN set' : 'PIN removed');
          onOpenChange(false);
        }}
      >
        <Input
          large
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <Button type="submit" variant="primary" disabled={pin.length !== 0 && pin.length !== 6}>
          Save
        </Button>
      </form>
    </Dialog>
  );
}
