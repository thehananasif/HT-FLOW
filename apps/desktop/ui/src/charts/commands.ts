/**
 * Chart commands (P26 / P08): every chart menu action is also a Command Palette entry with a
 * rebindable shortcut. Commands act on the active chart window.
 */
import { LAYOUT_PRESETS, type WindowState } from '@htflow/workspace';
import { registerCommands, runCommand, type Command } from '../shell/commands';
import { useWindows } from '../state/windows';
import { activeChartId, chartAction, type ChartAction } from './bus';
import { DISPLAY_MODES, MOUSE_MODES, TRADING_SESSIONS } from './settings/schema';
import { chartSettings, extState, patchChartExt, setChartSetting } from './settings/state';
import { useChartSettingsUi } from './settingsUi';
import { applyTemplateTo, useChartTemplates } from './templateStore';
import { allTemplates } from './templates';

const MODE_KEYS: Record<string, string> = {
  bars: 'Shift+B',
  candles: 'Shift+C',
  transparent: 'Shift+T',
  line: 'Shift+L',
  area: 'Shift+M',
  hidden: 'Shift+H',
};

const onActive = (fn: (id: string) => void) => () => {
  const id = activeChartId();
  if (id) fn(id);
};

const set = (key: string, value: unknown) => onActive((id) => setChartSetting(id, key, value));

const toggle = (key: string) =>
  onActive((id) => {
    const w = useWindows.getState().windows[id];
    if (w?.kind !== 'chart') return;
    setChartSetting(id, key, !chartSettings(w)[key]);
  });

const act = (a: ChartAction) => () => chartAction(a);

/** Opens the Chart settings window for the active chart (Ctrl+S). */
export function openChartSettings(windowId = activeChartId()): void {
  if (windowId) useChartSettingsUi.getState().open(windowId);
}

export function openLinkedWindow(windowId: string, kind: 'chart' | 'dom', template?: string): void {
  const { windows, patch } = useWindows.getState();
  const s = windows[windowId];
  if (!s || s.kind !== 'chart') return;
  let link = s.link;
  if (link === 'none') {
    const used = new Set(Object.values(windows).map((w) => (w.kind === 'module' ? '' : w.link)));
    link =
      (['blue', 'green', 'yellow', 'purple', 'red'] as const).find((c) => !used.has(c)) ?? 'blue';
    patch(windowId, { link } as Partial<WindowState>);
  }
  const state: WindowState =
    kind === 'dom'
      ? { kind: 'dom', instrumentId: s.instrumentId, lots: s.lots, link, grouping: 1 }
      : {
          ...s,
          link,
          template: (template as typeof s.template) ?? s.template,
          ext: {},
        };
  window.dispatchEvent(
    new CustomEvent('htflow:open-window', { detail: { state, ref: windowId, dir: 'right' } }),
  );
}

export function cloneWindow(windowId: string): void {
  const s = useWindows.getState().windows[windowId];
  if (!s) return;
  window.dispatchEvent(
    new CustomEvent('htflow:open-window', {
      detail: { state: structuredClone(s), ref: windowId, dir: 'right' },
    }),
  );
}

const STATIC: Command[] = [
  {
    id: 'chart.settings',
    label: 'Chart settings…',
    group: 'Chart',
    shortcut: 'Ctrl+S',
    scope: 'chart',
    keywords: 'P34 colours scales visual footprint trading templates',
    run: () => openChartSettings(),
  },
  {
    id: 'chart.goto-date',
    label: 'Chart: Go to date…',
    group: 'Chart',
    shortcut: 'Ctrl+G',
    scope: 'chart',
    keywords: 'calendar jump',
    run: act('goto-date'),
  },
  {
    id: 'chart.reset',
    label: 'Chart: Reset (go to latest, auto-scale)',
    group: 'Chart',
    shortcut: 'Ctrl+R',
    scope: 'chart',
    run: act('reset'),
  },
  {
    id: 'chart.change-instrument',
    label: 'Chart: Change instrument…',
    group: 'Chart',
    run: act('change-instrument'),
  },
  {
    id: 'chart.overlay',
    label: 'Chart: Overlay / compare instrument…',
    group: 'Chart',
    keywords: 'compare',
    run: act('overlay'),
  },
  {
    id: 'chart.clear-overlays',
    label: 'Chart: Remove overlays',
    group: 'Chart',
    run: act('clear-overlays'),
  },
  {
    id: 'chart.template.save',
    label: 'Chart: Save as template…',
    group: 'Chart',
    run: act('save-template'),
  },
  { id: 'chart.refresh', label: 'Chart: Refresh', group: 'Chart', run: act('refresh') },
  {
    id: 'chart.reload-history',
    label: 'Chart: Reload all historical data',
    group: 'Chart',
    run: act('reload-history'),
  },
  {
    id: 'chart.load-older',
    label: 'Chart: Load older history',
    group: 'Chart',
    run: act('load-older'),
  },
  { id: 'chart.export.png', label: 'Chart: Export PNG', group: 'Chart', run: act('export-png') },
  {
    id: 'chart.export.csv',
    label: 'Chart: Export bars CSV',
    group: 'Chart',
    run: act('export-csv'),
  },
  {
    id: 'chart.export.clusters',
    label: 'Chart: Export clusters CSV',
    group: 'Chart',
    run: act('export-clusters'),
  },
  {
    id: 'chart.export.json',
    label: 'Chart: Export bars JSON',
    group: 'Chart',
    run: act('export-json'),
  },
  {
    id: 'chart.export.template',
    label: 'Chart: Export template JSON',
    group: 'Chart',
    run: act('export-template'),
  },
  {
    id: 'chart.fullscreen',
    label: 'Chart: Full screen',
    group: 'Chart',
    shortcut: 'F11',
    scope: 'chart',
    run: act('fullscreen'),
  },
  { id: 'chart.clone', label: 'Chart: Clone window', group: 'Layout', run: onActive(cloneWindow) },
  {
    id: 'chart.linked.chart',
    label: 'Chart: Create linked chart',
    group: 'Layout',
    run: onActive((id) => openLinkedWindow(id, 'chart')),
  },
  {
    id: 'chart.linked.dom',
    label: 'Chart: Create linked DOM',
    group: 'Layout',
    run: onActive((id) => openLinkedWindow(id, 'dom')),
  },
  {
    id: 'chart.hide-panels',
    label: 'Chart: Hide / show panels',
    group: 'Chart',
    run: toggle('other.hidePanels'),
  },
  {
    id: 'chart.data-window',
    label: 'Chart: Data window',
    group: 'Chart',
    shortcut: 'Ctrl+D',
    scope: 'chart',
    run: toggle('crosshair.dataWindow'),
  },
  {
    id: 'chart.pin',
    label: 'Chart: Pin (keep instrument when the link group changes)',
    group: 'Chart',
    run: onActive((id) => {
      const w = useWindows.getState().windows[id];
      if (w?.kind === 'chart') patchChartExt(id, { pinned: !extState(w).pinned });
    }),
  },
  {
    id: 'chart.scale.linear',
    label: 'Chart scale: Linear',
    group: 'Chart',
    run: set('scales.mode', 'linear'),
  },
  {
    id: 'chart.scale.log',
    label: 'Chart scale: Logarithmic',
    group: 'Chart',
    run: set('scales.mode', 'log'),
  },
  {
    id: 'chart.scale.percent',
    label: 'Chart scale: Percent',
    group: 'Chart',
    run: set('scales.mode', 'percent'),
  },
  {
    id: 'chart.scale.indexed',
    label: 'Chart scale: Indexed to 100',
    group: 'Chart',
    run: set('scales.mode', 'indexed'),
  },
  {
    id: 'chart.scale.invert',
    label: 'Chart scale: Invert',
    group: 'Chart',
    shortcut: 'Alt+I',
    scope: 'chart',
    run: toggle('scales.invert'),
  },
  { id: 'chart.gaps', label: 'Chart: Show time gaps', group: 'Chart', run: toggle('scales.gaps') },
  {
    id: 'chart.watermark',
    label: 'Chart: Watermark',
    group: 'Chart',
    run: toggle('marks.watermark'),
  },
  {
    id: 'chart.high-low',
    label: 'Chart: High / low marks',
    group: 'Chart',
    run: toggle('marks.highLow'),
  },
  {
    id: 'chart.countdown',
    label: 'Chart: Bar countdown',
    group: 'Chart',
    run: toggle('price.countdown'),
  },
  {
    id: 'chart.crosshair.sync',
    label: 'Mouse: Sync crosshair (link group)',
    group: 'Chart',
    run: set('crosshair.sync', 'link'),
  },
  {
    id: 'chart.crosshair.global',
    label: 'Mouse: Global crosshair (all windows)',
    group: 'Chart',
    run: set('crosshair.sync', 'global'),
  },
  {
    id: 'chart.crosshair.off',
    label: 'Mouse: Crosshair sync off',
    group: 'Chart',
    run: set('crosshair.sync', 'off'),
  },
  ...DISPLAY_MODES.map((m) => ({
    id: `chart.mode.${m.value}`,
    label: `Chart mode: ${m.label}`,
    group: 'Chart' as const,
    shortcut: MODE_KEYS[m.value],
    scope: 'chart' as const,
    run: set('main.displayMode', m.value),
  })),
  ...MOUSE_MODES.map((m) => ({
    id: `chart.mouse.${m.value}`,
    label: `Mouse: ${m.label}`,
    group: 'Chart' as const,
    run: set('crosshair.mouseMode', m.value),
  })),
  ...TRADING_SESSIONS.map((m) => ({
    id: `chart.session.${m.value}`,
    label: `Trading session: ${m.label}`,
    group: 'Chart' as const,
    run: set('session.trading', m.value),
  })),
  ...LAYOUT_PRESETS.map((p) => ({
    id: `chart.layouts.${p.id}`,
    label: `Chart menu › Layouts: ${p.label}`,
    group: 'Layout' as const,
    run: () => runCommand(`layout.${p.id}`),
  })),
];

let unTemplates: (() => void) | null = null;

/** Template commands follow the template library (Template: <name>). */
function registerTemplateCommands(): void {
  unTemplates?.();
  const lib = useChartTemplates.getState().lib;
  unTemplates = registerCommands(
    allTemplates(lib).map((t) => ({
      id: `chart.template.apply.${t.id}`,
      label: `Chart template: ${t.name}${t.favourite ? ' ★' : ''}`,
      group: 'Chart' as const,
      keywords: 'template style preset',
      run: onActive((id) => applyTemplateTo(id, t.id)),
    })),
  );
}

let installed = false;
export function installChartCommands(): void {
  if (installed) return;
  installed = true;
  registerCommands(STATIC);
  registerTemplateCommands();
  useChartTemplates.subscribe((s, prev) => {
    if (s.lib !== prev.lib) registerTemplateCommands();
  });
  void useChartTemplates.getState().load();
}
