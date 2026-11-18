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
  CircleHelp,
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
  SegmentedControl,
  toast,
  type MenuEntry,
} from '@htflow/ui-kit';
import { FOOTPRINT_MODES } from '@htflow/footprint';
import {
  CHART_TEMPLATES,
  LAYOUT_PRESETS,
  windowTitle,
  type ChartTemplateId,
  type LayoutPresetId,
  type PanelSpec,
  type WindowState,
  type WorkspaceDoc,
  type WorkspaceTab,
  stripRemovedModules,
  cloneWindowState,
} from '@htflow/workspace';
import { backend, BackendError } from '../backend';
import { useSession } from '../state/session';
import { getSetting, settingsReady, useSetting } from '../state/settings';
import { activeInstrument, useWindows } from '../state/windows';
import { INSTRUMENT_MIME, decodePayload, resolveDrop, retargetPatch } from './instrumentDrop';
import { DEFAULT_INSTRUMENT, allInstruments, instrumentById } from '../state/instruments';
import { paper } from '../state/market';
import { activeAccount, routedAccount } from '../trading/accounts';
import { isTauri } from '../backend';
import { BrandIcon } from '../components/Brand';
import { TitleBar } from '../shell/TitleBar';
import { Ribbon } from '../shell/Ribbon';
import { StatusBar } from '../shell/StatusBar';
import { CommandPalette } from '../shell/CommandPalette';
import {
  installHotkeys,
  registerCommands,
  runCommand,
  setActiveWindowElement,
  type Command,
} from '../shell/commands';
import { MODULES } from '../shell/modules';
import { ChartWindow } from '../charts/ChartWindow';
import { newChartState } from '../charts/settings/globals';
import { newDomState } from '../trading/dom/globalSettings';
import { DomWindow } from '../trading/DomView';
import { TradingPanel } from '../trading/TradingPanel';
import { ModuleWindow } from './ModuleWindow';
import { risk, riskStore } from '../modules/risk/engine';
import { WindowHeader } from './WindowHeader';
import { setWorkspaceHost } from '../modules/workspaces/host';
import { WorkspaceMenu } from '../modules/workspaces/menu';
import { readOpenWindowDetail, type OpenDir } from '../modules/workspaces/windowActions';
import {
  attachDockBehaviour,
  defaultFloatingRect,
  isFloating,
  opensOsWindow,
  placeNewWindow,
  splitFloatingRect,
  toggleFloating,
} from '../modules/layout-settings/apply';
import {
  applyOsWindows,
  detachToOsWindow,
  detachUsesOsWindow,
  focusOsWindowOf,
  installOsWindowsMain,
  isDetached,
  openStateInOsWindow,
  osEntries,
  osWindowsAvailable,
  reattachAll,
  reattachWindow,
  suspendOsWindows,
} from '../platform/osWindows';
import { sanitizeEntries } from '../platform/windowBus';
import {
  captureDisplay,
  installDisplayTracking,
  prepareLayout,
  restoreMainWindow,
} from '../modules/layout-settings/display';

import { translateLiteral as tl, tt } from '@htflow/i18n';
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
  const dockHostRef = useRef<HTMLDivElement>(null);
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
  const detachRef = useRef<(mode?: 'auto' | 'float' | 'os') => void>(() => {});

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
      specs: undefined,
      // Separate OS windows of this tab (their states are in `windows`).
      osWindows: osEntries().length ? osEntries() : undefined,
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
      display: captureDisplay(t.layout, dockHostRef.current), // multi-monitor restore
    };
    docRef.current = next;
    setDoc(next);
    void backend.saveSettings('workspace', next);
  }, []);

  /** Builds panels from specs (presets, starter workspaces, imported files without a layout). */
  const buildSpecs = useCallback(
    (specs: PanelSpec[]) => {
      const api = apiRef.current;
      if (!api) return;
      for (const s of specs) addPanel(s.id, s.state, s.position);
      // Initial split sizes (editable afterwards by dragging splitters).
      for (const s of specs) {
        if (!s.size || !s.position) continue;
        const panel = api.getPanel(s.id);
        if (!panel) continue;
        if (s.position.dir === 'right' || s.position.dir === 'left')
          panel.api.setSize({ width: Math.round(api.width * s.size) });
        else if (s.position.dir === 'below' || s.position.dir === 'above')
          panel.api.setSize({ height: Math.round(api.height * s.size) });
      }
    },
    [addPanel],
  );

  const applyPreset = useCallback(
    (id: LayoutPresetId, instrumentId = activeInstrument() ?? DEFAULT_INSTRUMENT) => {
      const api = apiRef.current;
      if (!api) return;
      const p = LAYOUT_PRESETS.find((x) => x.id === id)!;
      loading.current = true;
      api.clear();
      useWindows.getState().setAll({});
      buildSpecs(p.build(instrumentId));
      useWindows.getState().setTradingPanel(p.tradingPanel);
      setPreset(id);
      loading.current = false;
      save();
    },
    [buildSpecs, save],
  );

  const restoreTab = useCallback(
    (tab: WorkspaceTab) => {
      const api = apiRef.current;
      if (!api) return;
      loading.current = true;
      try {
        useWindows.getState().setAll(tab.windows);
        api.clear();
        if (tab.layout) {
          // Floating windows are clamped / scaled into today's docking area (multi-monitor restore).
          const layout = prepareLayout(tab.layout, docRef.current.display, {
            width: api.width,
            height: api.height,
          });
          api.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0]);
        } else if (tab.specs?.length) buildSpecs(tab.specs);
        useWindows.getState().setTradingPanel(tab.tradingPanel);
        // OS windows of this tab (desktop) — floating windows in the browser build.
        applyOsWindows(sanitizeEntries(tab.osWindows, tab.windows));
      } catch (e) {
        console.warn('Workspace restore failed, applying default preset', e);
        loading.current = false;
        applyPreset('dom-chart-panel');
      }
      loading.current = false;
    },
    [applyPreset, buildSpecs],
  );

  /** Replaces the whole workspace (Workspaces manager → Load / import / starter). */
  const loadDoc = useCallback(
    (loaded: WorkspaceDoc) => {
      const d = stripRemovedModules(loaded);
      docRef.current = d;
      setDoc(d);
      restoreTab(d.tabs.find((t) => t.id === d.activeTab) ?? d.tabs[0]!);
      void restoreMainWindow(d.display);
      void backend.saveSettings('workspace', d);
    },
    [restoreTab],
  );

  const onReady = useCallback(
    (e: DockviewReadyEvent) => {
      apiRef.current = e.api;
      // Layout settings (gap, lock, snapping) and the Workspaces manager bridge (P25 / P37).
      attachDockBehaviour(e.api, theme);
      installDisplayTracking();
      setWorkspaceHost({
        snapshot: () => {
          const t = snapshotTab();
          const d = docRef.current;
          return {
            ...d,
            tabs: t ? d.tabs.map((x) => (x.id === t.id ? t : x)) : d.tabs,
            savedAt: Date.now(),
            display: captureDisplay(t?.layout ?? null, dockHostRef.current),
          };
        },
        load: loadDoc,
        rename: (name) => {
          const next = { ...docRef.current, name };
          docRef.current = next;
          setDoc(next);
          void backend.saveSettings('workspace', next);
        },
        focusWindow: (id) => {
          if (!focusOsWindowOf(id)) e.api.getPanel(id)?.api.setActive();
        },
        closeWindow: (id) => e.api.getPanel(id)?.api.close(),
        isFloating: (id) => isFloating(e.api, id),
        toggleFloating: (id) => toggleFloating(e.api, id),
        detachWindow: (id, mode) => {
          useWindows.getState().setActive(id);
          e.api.getPanel(id)?.api.setActive();
          detachRef.current(mode);
        },
      });
      // A panel that moved into an OS window keeps its window state.
      e.api.onDidRemovePanel((p) => {
        if (!loading.current && !isDetached(p.id)) useWindows.getState().remove(p.id);
      });
      installOsWindowsMain({
        groupOf: (id) => e.api.getPanel(id)?.group.panels.map((x) => x.id) ?? [id],
        takePanels: (ids) => {
          for (const id of ids) {
            const panel = e.api.getPanel(id);
            if (panel) e.api.removePanel(panel);
          }
        },
        putPanels: (ids, o) => {
          let first: string | null = null;
          for (const id of ids) {
            const st = useWindows.getState().windows[id];
            if (!st || e.api.getPanel(id)) continue;
            const ref = first ? e.api.getPanel(first) : undefined;
            if (ref)
              e.api.addPanel({
                id,
                component: st.kind,
                title: title(st),
                position: { referencePanel: ref, direction: 'within' },
              });
            else placeNewWindow(e.api, { id, state: st, title: title(st), floating: o.floating });
            first ??= id;
          }
          if (first) e.api.getPanel(first)?.api.setActive();
        },
        titleOf: (id) => {
          const st = useWindows.getState().windows[id];
          return st ? title(st) : 'HT Flow';
        },
        newId,
        requestSave: () => setTimeout(save, 0),
      });
      e.api.onDidActivePanelChange((p) => p && useWindows.getState().setActive(p.id));
      let timer: ReturnType<typeof setTimeout> | null = null;
      e.api.onDidLayoutChange(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 800);
      });
      // The start-up choice lives in Settings → General, which loads together with the profile.
      void Promise.all([backend.loadSettings<WorkspaceDoc>('workspace'), settingsReady()]).then(
        ([stored]) => {
          // Windows of removed modules (TradersTalk, Following Manager) are dropped silently.
          const saved = stored?.tabs?.length ? stripRemovedModules(stored) : stored;
          if (saved && saved.tabs?.length) {
            docRef.current = saved;
            setDoc(saved);
            const active = saved.tabs.find((t) => t.id === saved.activeTab) ?? saved.tabs[0]!;
            if (getSetting('general.startupWorkspace') === 'default') {
              // "Default layout": the active layout tab is reset, other saved tabs are kept.
              docRef.current = { ...saved, activeTab: active.id };
              applyPreset('dom-chart-panel', DEFAULT_INSTRUMENT);
            } else {
              restoreTab(active);
              void restoreMainWindow(saved.display);
            }
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
        },
      );
    },
    [applyPreset, restoreTab, save, loadDoc],
  );

  // Persist on window-state changes and every 60 s (P25 autosave).
  useEffect(() => {
    const t = setTimeout(save, 500);
    return () => clearTimeout(t);
  }, [windows, tradingPanel, save]);
  const autosaveSec = useSetting('general.autosaveSec'); // Settings → General
  useEffect(() => {
    const i = setInterval(save, autosaveSec * 1000);
    return () => clearInterval(i);
  }, [save, autosaveSec]);

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
    if (target.layout || target.specs?.length) restoreTab(target);
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

  /** New windows open docked or floating as Layout settings say (callers may override). */
  const openWindow = useCallback(
    (
      state: WindowState,
      opts: { ref?: string; dir?: OpenDir; floating?: boolean; osWindow?: boolean } = {},
    ) => {
      const api = apiRef.current;
      if (!api) return;
      // "In new OS window" (or Layout settings: open in New OS window); browser: floating.
      const os =
        opts.osWindow ?? (opts.floating === undefined && !opts.dir && opensOsWindow(state));
      if (os && openStateInOsWindow(state)) return;
      if (opts.osWindow) opts = { ...opts, floating: true };
      const id = newId(state.kind);
      useWindows.getState().add(id, state);
      placeNewWindow(api, { id, state, title: title(state), ...opts });
    },
    [],
  );

  /** The window commands act on: dockview's active panel, else the last focused, else any. */
  const targetPanel = useCallback(() => {
    const api = apiRef.current;
    if (!api) return null;
    const known = (id: string | null | undefined) =>
      id && useWindows.getState().windows[id] ? api.getPanel(id) : undefined;
    return (
      known(api.activePanel?.id) ??
      known(useWindows.getState().activeId) ??
      api.panels.find((p) => known(p.id) && p.group.api.location.type === 'grid') ??
      api.panels.find((p) => known(p.id)) ??
      null
    );
  }, []);

  /** Split right / down: a copy of the target window next to it (floating ones float beside). */
  const split = useCallback(
    (dir: 'right' | 'below') => {
      const api = apiRef.current;
      const target = targetPanel();
      if (!api || !target) {
        toast('info', tl('Nothing to split'), tl('Open or select a window first.'));
        return;
      }
      const state = cloneWindowState(useWindows.getState().windows[target.id]!);
      const id = newId(state.kind);
      if (target.group.api.location.type === 'floating') {
        // Floating groups cannot be split: the copy floats next to the source window.
        const host = dockHostRef.current?.getBoundingClientRect();
        const box = target.group.element.getBoundingClientRect();
        const r = splitFloatingRect(
          {
            x: box.left - (host?.left ?? 0),
            y: box.top - (host?.top ?? 0),
            width: box.width,
            height: box.height,
          },
          dir,
          { width: api.width, height: api.height },
        );
        useWindows.getState().add(id, state);
        api.addPanel({
          id,
          component: state.kind,
          title: title(state),
          floating: { position: { left: r.x, top: r.y }, width: r.width, height: r.height },
        });
      } else addPanel(id, state, { ref: target.id, dir });
      api.getPanel(id)?.api.setActive();
    },
    [addPanel, targetPanel],
  );

  /** Window (dock group) under a screen point, or null over empty dock area. */
  const windowAt = useCallback((target: EventTarget | null): string | null => {
    const api = apiRef.current;
    if (!api || !(target instanceof Node)) return null;
    let hit: string | null = null;
    for (const g of api.groups) if (g.element.contains(target)) hit = g.activePanel?.id ?? hit;
    return hit;
  }, []);

  const onInstrumentDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(INSTRUMENT_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
  }, []);

  const onInstrumentDrop = useCallback(
    (e: React.DragEvent) => {
      const payload = decodePayload(e.dataTransfer.getData(INSTRUMENT_MIME));
      if (!payload) return;
      e.preventDefault();
      const act = resolveDrop(payload, { ctrl: e.ctrlKey, targetId: windowAt(e.target) });
      if (act.kind === 'retarget') {
        const w = useWindows.getState().windows[act.windowId];
        if (w) useWindows.getState().patch(act.windowId, retargetPatch(w, act.feedId));
      } else openWindow(newChartState(act.feedId, 'footprint'));
    },
    [openWindow, windowAt],
  );

  /**
   * Detach window: into its own OS window (desktop app, Layout settings: Detach window opens) or
   * a floating window inside the main window (browser build, or when chosen).
   */
  const detach = useCallback(
    (mode: 'auto' | 'float' | 'os' = 'auto') => {
      const api = apiRef.current;
      const target = targetPanel();
      if (!api || !target) {
        toast('info', tl('Nothing to detach'), tl('Open or select a window first.'));
        return;
      }
      const os = mode === 'os' ? osWindowsAvailable() : mode === 'auto' && detachUsesOsWindow();
      if (os && detachToOsWindow(target.id)) return;
      if (mode === 'os' && !osWindowsAvailable())
        toast('info', tl('Floating instead'), tl('Separate OS windows need the desktop app.'));
      if (target.group.api.location.type === 'floating') {
        target.api.setActive();
        return; // already floating
      }
      const r = defaultFloatingRect(api); // Layout settings: default size / placement
      api.addFloatingGroup(target, {
        position: { left: r.x, top: r.y },
        width: r.width,
        height: r.height,
      });
      target.api.setActive();
    },
    [targetPanel],
  );
  detachRef.current = detach;

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
      {
        id: 'detach',
        label: 'Detach window',
        group: 'Layout',
        keywords: 'undock pop out monitor',
        run: () => detach(),
      },
      {
        id: 'detach-float',
        label: 'Detach window: floating inside the main window',
        group: 'Layout',
        keywords: 'undock float',
        run: () => detach('float'),
      },
      {
        id: 'detach-os',
        label: 'Detach window to a new OS window',
        group: 'Layout',
        keywords: 'undock pop out second monitor screen separate',
        run: () => detach('os'),
      },
      {
        id: 'window.reattach',
        label: 'Re-attach active window from its OS window',
        group: 'Layout',
        keywords: 'dock back monitor',
        run: () => {
          const id = useWindows.getState().activeId;
          if (!id || !reattachWindow(id))
            toast('info', tl('The active window is not in an OS window'));
        },
      },
      {
        id: 'window.reattach-all',
        label: 'Re-attach all OS windows',
        group: 'Layout',
        keywords: 'dock back monitor',
        run: () => {
          const n = reattachAll();
          toast('info', n ? `Re-attached ${n} window${n > 1 ? 's' : ''}` : 'No OS windows open');
        },
      },
      {
        id: 'ribbon-compact',
        label: 'Ribbon: icons only',
        group: 'Layout',
        run: () => setRibbonCompact((x) => !x),
      },
      {
        id: 'flatten-all',
        label: 'Flatten all positions (selected account)',
        group: 'Trading',
        run: () => paper.flattenAll(activeAccount()),
      },
      {
        id: 'breakeven',
        label: 'Breakeven',
        group: 'Trading',
        shortcut: 'H',
        run: () => paper.breakeven(routedAccount(inst()).id, inst()),
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
        run: () => openWindow(newChartState(inst(), t.id)),
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
          else openWindow(newChartState(i.id, 'footprint'));
        },
      })),
      ...MODULES.map((m) => ({
        id: `open.${m.id}`,
        label: `Open ${m.label}`,
        group: 'Analysis' as const,
        run: () => {
          if (m.id === 'chart') openWindow(newChartState(inst(), 'footprint'));
          else if (m.id === 'smart-dom') openWindow(newDomState(inst()));
          else
            openWindow({ kind: 'module', module: m.id }, m.id === 'replay' ? { dir: 'right' } : {});
        },
      })),
    ];
    const un = registerCommands(cmds);
    const unk = installHotkeys();
    setActiveWindowElement(() => {
      const a = useWindows.getState().activeId;
      return a ? document.querySelector(`[data-window-id="${CSS.escape(a)}"]`) : null;
    });
    // Modules outside the ribbon (e.g. the drawings Objects List) open through this event.
    // detail: a module id, or { module, position } where position is a split direction hint.
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent).detail as string | { module?: unknown; position?: unknown };
      const module = String(typeof d === 'object' && d ? d.module : d);
      const pos = typeof d === 'object' && d ? d.position : undefined;
      // An explicit split hint wins; otherwise the window opens where Layout settings say.
      const dir =
        pos === 'right' || pos === 'below' || pos === 'left' || pos === 'above' ? pos : undefined;
      openWindow({ kind: 'module', module }, dir ? { dir } : {});
    };
    window.addEventListener('htflow:open-module', onOpen);
    // Any window (chart, DOM, tape, module) — Clone / Create linked window use this (P25).
    const onOpenWindow = (e: Event) => {
      const d = readOpenWindowDetail((e as CustomEvent).detail);
      if (d)
        openWindow(d.state, { ref: d.ref, dir: d.dir, floating: d.floating, osWindow: d.osWindow });
    };
    window.addEventListener('htflow:open-window', onOpenWindow);
    return () => {
      un();
      unk();
      window.removeEventListener('htflow:open-module', onOpen);
      window.removeEventListener('htflow:open-window', onOpenWindow);
    };
  }, [applyPreset, openWindow, split, detach, addPanel]);

  // Lock / sign-out unmounts the dashboard: its OS windows close (they come back on unlock).
  useEffect(() => () => suspendOsWindows(), []);

  // Auto-lock after idle (P03 setting; default 30 min).
  useEffect(() => {
    let last = Date.now();
    const bump = () => (last = Date.now());
    window.addEventListener('mousemove', bump);
    window.addEventListener('keydown', bump);
    const i = setInterval(() => {
      const mins = getSetting('general.autoLockMin'); // Settings → General (0 = never)
      if (mins > 0 && Date.now() - last > mins * 60_000) void useSession.getState().lock();
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
          <BrandIcon size={16} />
          <span className="tb-logo">
            {tl('HT')}
            <br />
            {tl('FLOW')}
          </span>
        </div>
        <WorkspaceMenu
          trigger={
            <button className="tb-workspace" data-testid="workspace-menu">
              <span className="muted">{tl('Workspace:')}</span> {doc.name} ▾
            </button>
          }
        />
        <div className="tb-group">
          <span className="muted">{tl('Layout')}</span>
          <SegmentedControl
            aria-label={tl('Layout presets')}
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
            <span className="muted">{tl('Main chart')}</span>
            {CHART_TEMPLATES.filter((t) => !t.more).map((t) => (
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
            <ArrowRightToLine size={13} /> {tl('Split right')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => split('below')}>
            <ArrowDownToLine size={13} /> {tl('Split down')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => detach()}>
            <ExternalLink size={13} /> {tl('Detach window')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={tradingPanel}
            onClick={() => useWindows.getState().setTradingPanel(!tradingPanel)}
          >
            <PanelRight size={13} /> {tl('Panel')}
          </Button>
        </div>
        <HelpMenu />
        <RiskMeter />
        <AccountMenu name={session.displayName} />
      </TitleBar>
      <Ribbon compact={ribbonCompact} />
      <div className="workspace-row">
        <div
          className="dock-host"
          ref={dockHostRef}
          onDragOver={onInstrumentDragOver}
          onDrop={onInstrumentDrop}
          data-testid="dock-host"
        >
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
      <div className="ws-tabs">
        {/* Tabs: roving focus (← / →, Home / End), Enter / Space opens, F2 renames, Delete closes. */}
        <div className="ws-tablist" role="tablist" aria-label={tl('Workspace layouts')}>
          {doc.tabs.map((t, i) => (
            <div
              key={t.id}
              className="ws-tab"
              role="tab"
              tabIndex={t.id === doc.activeTab ? 0 : -1}
              aria-selected={t.id === doc.activeTab}
              aria-keyshortcuts={doc.tabs.length > 1 ? 'F2 Delete' : 'F2'}
              onClick={() => t.id !== doc.activeTab && switchTab(t.id)}
              onDoubleClick={() => renameTab(t.id)}
              onKeyDown={(e) => {
                const tabs = [
                  ...e.currentTarget.parentElement!.querySelectorAll<HTMLElement>('[role="tab"]'),
                ];
                const go = (k: number) => tabs[(k + tabs.length) % tabs.length]?.focus();
                if (e.key === 'ArrowRight') go(i + 1);
                else if (e.key === 'ArrowLeft') go(i - 1);
                else if (e.key === 'Home') go(0);
                else if (e.key === 'End') go(tabs.length - 1);
                else if (e.key === 'Enter' || e.key === ' ') {
                  if (t.id !== doc.activeTab) switchTab(t.id);
                } else if (e.key === 'F2') renameTab(t.id);
                else if (e.key === 'Delete' && doc.tabs.length > 1) closeTab(t.id);
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              {t.name}
              {doc.tabs.length > 1 && (
                // Mouse affordance only (a tab's children are presentational); keyboard: Delete.
                <span
                  className="ws-tab-x"
                  aria-hidden="true"
                  title={tt`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <X size={11} />
                </span>
              )}
            </div>
          ))}
        </div>
        <button className="ws-tab ws-tab-add" aria-label={tl('Add layout')} onClick={addTab}>
          <Plus size={13} />
        </button>
      </div>
      <StatusBar version={version} timezone={session.timezone} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/** Daily risk meter in the title bar, driven by the risk engine (P23 / P41). */
function RiskMeter() {
  const [, set] = useState(0);
  useEffect(() => {
    const bump = () => set((x) => x + 1);
    const a = paper.subscribe(bump);
    const b = riskStore.subscribe(bump);
    const i = setInterval(bump, 1000);
    return () => {
      a();
      b();
      clearInterval(i);
    };
  }, []);
  const accId = activeAccount();
  const st = risk.status(accId);
  const rule = risk.rules(accId).dailyLossLimit;
  const accName = paper.accounts.get(accId)?.name ?? accId;
  const pct = st.locked ? 1 : Math.min(1, st.dailyLossUsed);
  const loss = Math.max(0, -st.dayPnl);
  const title =
    `${accName} · ` +
    (st.locked
      ? `Locked: ${st.lockReason ?? ''}`
      : rule.enabled
        ? `Daily loss ${loss.toFixed(2)} of ${rule.value} limit (${Math.round(pct * 100)}%)`
        : 'Daily loss limit is off');
  return (
    <div className="tb-risk" title={title} data-testid="risk-meter" data-state={st.state}>
      <span className="muted">{st.locked ? 'Locked' : 'Daily risk'}</span>
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

function HelpMenu() {
  const items: MenuEntry[] = [
    {
      id: 'guide',
      label: 'User Guide',
      shortcut: 'F1',
      onSelect: () => runCommand('user-guide.open'),
    },
    {
      id: 'panel',
      label: 'Help for this window',
      shortcut: 'Shift+F1',
      onSelect: () => runCommand('user-guide.help-panel'),
    },
    { id: 'keys', label: 'Keyboard shortcuts', onSelect: () => runCommand('user-guide.shortcuts') },
    { id: 'tour', label: 'Start guided tour', onSelect: () => runCommand('tour.start') },
    { kind: 'separator', id: 'hs' },
    { id: 'upd', label: 'Check for updates', onSelect: () => runCommand('platform.checkUpdates') },
    { id: 'rep', label: 'Report a problem…', onSelect: () => runCommand('platform.reportProblem') },
  ];
  return (
    <DropdownMenu
      align="end"
      items={items}
      trigger={
        <button className="ht-icon-btn" aria-label={tl('Help menu')} data-testid="help-menu">
          <CircleHelp size={15} />
        </button>
      }
    />
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
        tl('Profile exported'),
        tl('The .htprofile file stays encrypted with your password.'),
      );
    } catch (e) {
      toast('error', tl('Export failed'), e instanceof Error ? e.message : String(e));
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
          <button className="avatar" aria-label={tl('Account menu')} data-testid="account-menu">
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
    <Dialog open={open} onOpenChange={onOpenChange} title={tl('Change password')} width={400}>
      <form
        className="col gap12"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await backend.changePassword(a, b);
            toast('success', tl('Password changed'));
            onOpenChange(false);
          } catch (x) {
            setErr(x instanceof BackendError ? x.message : String(x));
          }
        }}
      >
        <Field label={tl('Current password')}>
          <Input type="password" value={a} onChange={(e) => setA(e.target.value)} />
        </Field>
        <Field label={tl('New password (min 10)')} error={err}>
          <Input type="password" value={b} onChange={(e) => setB(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={b.length < 10}>
          {tl('Change password')}
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
      title={tl('Quick-unlock PIN')}
      description={tl('6 digits. Leave empty to remove the PIN.')}
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
          {tl('Save')}
        </Button>
      </form>
    </Dialog>
  );
}
