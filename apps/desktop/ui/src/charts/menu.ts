/**
 * Chart right-click menu (P26), context-aware: the items depend on what is under the cursor —
 * price axis, time axis, a sub-pane / separator, or the price pane (full menu).
 */
import type { HitInfo } from '@htflow/chart-engine';
import { formatPrice, type MarketStore } from '@htflow/market-data';
import { FOOTPRINT_MODES } from '@htflow/footprint';
import type { MenuEntry } from '@htflow/ui-kit';
import {
  CHART_TEMPLATES,
  LAYOUT_PRESETS,
  type ChartWindowState,
  type WindowState,
} from '@htflow/workspace';
import { runCommand } from '../shell/commands';
import { useWindows } from '../state/windows';
import type { ChartHandle } from './buildChart';
import { chartAction, type ChartAction } from './bus';
import { cloneWindow, openChartSettings, openLinkedWindow } from './commands';
import {
  DISPLAY_MODES,
  MOUSE_MODES,
  TIME_ZONES,
  TRADING_SESSIONS,
  sBool,
  sStr,
  type ChartSettings,
} from './settings/schema';
import { patchChartExt, setChartSetting, type ChartExtState } from './settings/state';
import { useChartSettingsUi } from './settingsUi';
import { applyTemplateTo } from './templateStore';
import { allTemplates, type TemplateLibrary } from './templates';

export interface MenuContext {
  windowId: string;
  state: ChartWindowState;
  settings: ChartSettings;
  ext: ChartExtState;
  store: MarketStore;
  hit: HitInfo;
  menuPx: number | null;
  lib: TemplateLibrary;
  domTrader: boolean;
  handle: ChartHandle | null;
  toggleDomTrader(): void;
  order(side: 'buy' | 'sell', type: 'limit' | 'stop'): void;
  extensionItems: MenuEntry[];
}

const sep = (id: string): MenuEntry => ({ kind: 'separator', id });

export function buildChartMenu(c: MenuContext): MenuEntry[] {
  const id = c.windowId;
  const s = c.settings;
  const set = (k: string, v: unknown) => () => setChartSetting(id, k, v);
  const act = (a: ChartAction) => () => chartAction(a, id);
  const choice = (
    key: string,
    prefix: string,
    list: { value: string; label: string }[],
    shortcuts: Record<string, string> = {},
  ): MenuEntry[] =>
    list.map((o) => ({
      id: `${prefix}-${o.value}`,
      label: o.label,
      checked: sStr(s, key) === o.value,
      ...(shortcuts[o.value] ? { shortcut: shortcuts[o.value] } : {}),
      onSelect: set(key, o.value),
    }));

  const scaleItems: MenuEntry[] = [
    ...choice('scales.mode', 'scale', [
      { value: 'linear', label: 'Linear' },
      { value: 'log', label: 'Logarithmic' },
      { value: 'percent', label: 'Percent' },
      { value: 'indexed', label: 'Indexed to 100' },
    ]),
    sep('sc1'),
    {
      id: 'invert',
      label: 'Invert scale',
      shortcut: 'Alt+I',
      checked: sBool(s, 'scales.invert'),
      onSelect: set('scales.invert', !sBool(s, 'scales.invert')),
    },
    {
      id: 'autofit',
      label: 'Auto-fit (auto scale)',
      onSelect: () => {
        c.handle?.cores.forEach((core) => {
          core.autoScale = true;
          core.invalidate();
        });
        setChartSetting(id, 'scales.autoScale', true);
      },
    },
    {
      kind: 'submenu',
      id: 'axis-side',
      label: 'Price axis',
      items: choice('scales.side', 'side', [
        { value: 'right', label: 'Right' },
        { value: 'left', label: 'Left' },
        { value: 'both', label: 'Both' },
      ]),
    },
    {
      id: 'scale-settings',
      label: 'Scale settings…',
      onSelect: () => openChartSettings(id),
    },
  ];

  const tzItems = choice('scales.timeZone', 'tz', TIME_ZONES);
  const sessionItems = choice('session.trading', 'sess', TRADING_SESSIONS);

  if (c.hit.area === 'price-axis') {
    return [{ kind: 'label', id: 'l', label: 'Price scale' }, ...scaleItems];
  }
  if (c.hit.area === 'time-axis') {
    return [
      { kind: 'label', id: 'l', label: 'Time axis' },
      { kind: 'submenu', id: 'tz', label: 'Time zone', items: tzItems },
      { kind: 'submenu', id: 'sess', label: 'Trading session', items: sessionItems },
      {
        id: 'gaps',
        label: 'Show time gaps',
        checked: sBool(s, 'scales.gaps'),
        onSelect: set('scales.gaps', !sBool(s, 'scales.gaps')),
      },
      ...choice('scales.timeFormat', 'tf', [
        { value: '24h', label: '24-hour time' },
        { value: '12h', label: '12-hour time' },
      ]),
      sep('t1'),
      { id: 'goto', label: 'Go to date…', shortcut: 'Ctrl+G', onSelect: act('goto-date') },
      { id: 'reset', label: 'Reset', shortcut: 'Ctrl+R', onSelect: act('reset') },
    ];
  }
  if ((c.hit.area === 'pane' || c.hit.area === 'separator') && c.hit.layerId) {
    const layerId = c.hit.layerId;
    const layer = c.handle?.main.layers.find((l) => l.id === layerId);
    const maximised = c.handle?.main.maximizedPane === layerId;
    return [
      { kind: 'label', id: 'l', label: `Pane · ${layer?.paneLabel ?? layerId}` },
      {
        id: 'max',
        label: maximised ? 'Restore pane' : 'Maximize pane',
        onSelect: () => c.handle?.main.toggleMaximizePane(layerId),
      },
      {
        id: 'reset-panes',
        label: 'Reset pane heights',
        onSelect: () => {
          c.handle?.main.resetPanes();
          patchChartExt(id, { panes: {} });
        },
      },
      ...(layerId === 'volume-pane'
        ? [{ id: 'hide-vol', label: 'Hide volume pane', onSelect: set('volume.pane', false) }]
        : []),
      ...c.extensionItems,
      sep('p1'),
      {
        id: 'settings',
        label: 'Settings…',
        shortcut: 'Ctrl+S',
        onSelect: () => openChartSettings(id),
      },
    ];
  }

  // ---------------------------------------------------------------- full menu (price pane)
  const inst = c.store.instrument;
  const priceLabel = c.menuPx !== null ? formatPrice(c.menuPx, inst) : '';
  const last = c.store.lastTrade?.px ?? c.store.book.mid;
  const above = c.menuPx !== null && c.menuPx > last;
  const tradeMode = sStr(s, 'trading.mode');
  const priced = c.menuPx !== null;
  const tradeItems: MenuEntry[] = !priced
    ? []
    : [
        ...(tradeMode !== 'stop'
          ? [
              above
                ? {
                    id: 'sl',
                    label: `Sell Limit at ${priceLabel}`,
                    onSelect: () => c.order('sell', 'limit'),
                  }
                : {
                    id: 'bl',
                    label: `Buy Limit at ${priceLabel}`,
                    onSelect: () => c.order('buy', 'limit'),
                  },
            ]
          : []),
        ...(tradeMode !== 'limit'
          ? [
              above
                ? {
                    id: 'bs',
                    label: `Buy Stop at ${priceLabel}`,
                    onSelect: () => c.order('buy', 'stop'),
                  }
                : {
                    id: 'ss',
                    label: `Sell Stop at ${priceLabel}`,
                    onSelect: () => c.order('sell', 'stop'),
                  },
            ]
          : []),
      ];

  const tplAll = allTemplates(c.lib);
  const favs = tplAll.filter((t) => t.favourite);
  const users = c.lib.templates;
  const presets = tplAll.filter((t) => t.preset);
  const tplItem = (t: (typeof tplAll)[number]): MenuEntry => ({
    id: `tpl-${t.id}`,
    label: `${t.favourite ? '★ ' : ''}${t.name}`,
    checked: c.ext.templateId === t.id,
    onSelect: () => applyTemplateTo(id, t.id),
  });
  const templates: MenuEntry[] = [
    { kind: 'label', id: 'tb', label: 'Built-in chart types' },
    ...CHART_TEMPLATES.map((t) => ({
      id: `b-${t.id}`,
      label: t.label,
      checked: c.state.template === t.id,
      onSelect: () => useWindows.getState().patch(id, { template: t.id } as Partial<WindowState>),
    })),
    ...(favs.length
      ? [
          sep('tf'),
          { kind: 'label' as const, id: 'tfl', label: 'Favourites' },
          ...favs.map(tplItem),
        ]
      : []),
    ...(users.length
      ? [
          sep('tu'),
          { kind: 'label' as const, id: 'tul', label: 'My templates' },
          ...users.map(tplItem),
        ]
      : []),
    sep('tp'),
    { kind: 'submenu', id: 'presets', label: 'Style presets', items: presets.map(tplItem) },
    sep('ts'),
    { id: 'save-tpl', label: 'Save as template…', onSelect: act('save-template') },
    { id: 'export-tpl', label: 'Export template JSON', onSelect: act('export-template') },
    {
      id: 'manage-tpl',
      label: 'Manage templates…',
      onSelect: () => useChartSettingsUi.getState().open(id, 'templates'),
    },
  ];

  const compare = c.ext.compare ?? [];
  const overlay: MenuEntry[] = [
    { id: 'ov-add', label: 'Add instrument…', onSelect: act('overlay') },
    ...compare.map((o) => ({
      id: `ov-${o.instrumentId}`,
      label: `Remove ${o.instrumentId.split(':').pop()}`,
      onSelect: () =>
        patchChartExt(id, { compare: compare.filter((x) => x.instrumentId !== o.instrumentId) }),
    })),
    ...(compare.length
      ? [{ id: 'ov-clear', label: 'Remove all overlays', onSelect: act('clear-overlays') }]
      : []),
  ];

  const mouseItems: MenuEntry[] = [
    ...choice('crosshair.mouseMode', 'mm', MOUSE_MODES.slice(0, 2)),
    {
      id: 'mm-global',
      label: 'Global Crosshair',
      checked: sStr(s, 'crosshair.sync') === 'global',
      onSelect: set('crosshair.sync', sStr(s, 'crosshair.sync') === 'global' ? 'off' : 'global'),
    },
    {
      id: 'mm-sync',
      label: 'Sync Crosshair',
      checked: sStr(s, 'crosshair.sync') === 'link',
      onSelect: set('crosshair.sync', sStr(s, 'crosshair.sync') === 'link' ? 'off' : 'link'),
    },
    ...choice('crosshair.mouseMode', 'mm', MOUSE_MODES.slice(2)),
  ];

  return [
    ...tradeItems,
    ...c.extensionItems.filter((e) => e.id.startsWith('alert') || e.id.includes('alert')),
    sep('s1'),
    {
      id: 'tp',
      label: 'Trading Panel',
      shortcut: 'T',
      onSelect: () => useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel),
    },
    { id: 'domt', label: 'DOM Trader', checked: c.domTrader, onSelect: c.toggleDomTrader },
    sep('s2'),
    { id: 'goto', label: 'Go to date…', shortcut: 'Ctrl+G', onSelect: act('goto-date') },
    { id: 'chg-inst', label: 'Change Instrument…', onSelect: act('change-instrument') },
    {
      kind: 'submenu',
      id: 'mode',
      label: 'Mode',
      items: [
        {
          kind: 'submenu',
          id: 'fp',
          label: 'Footprint',
          items: [
            ...FOOTPRINT_MODES.map((m) => ({
              id: m.id,
              label: m.label,
              shortcut: m.shortcut,
              checked: c.state.template === 'footprint' && c.state.footprintMode === m.id,
              onSelect: () =>
                useWindows.getState().patch(id, {
                  template: 'footprint',
                  footprintMode: m.id,
                } as Partial<WindowState>),
            })),
            sep('fps'),
            {
              id: 'fp-settings',
              label: 'Footprint settings…',
              onSelect: () => useChartSettingsUi.getState().open(id, 'footprint'),
            },
          ],
        },
        ...choice('main.displayMode', 'dm', DISPLAY_MODES, {
          bars: 'Shift+B',
          candles: 'Shift+C',
          transparent: 'Shift+T',
          line: 'Shift+L',
          area: 'Shift+M',
          hidden: 'Shift+H',
        }),
      ],
    },
    { kind: 'submenu', id: 'mouse', label: 'Mouse', items: mouseItems },
    { kind: 'submenu', id: 'scale', label: 'Price scale', items: scaleItems },
    sep('s3'),
    { kind: 'submenu', id: 'templates', label: 'Templates', items: templates },
    { kind: 'submenu', id: 'overlay', label: 'Overlay', items: overlay },
    ...c.extensionItems.filter((e) => !(e.id.startsWith('alert') || e.id.includes('alert'))),
    sep('s4'),
    {
      kind: 'submenu',
      id: 'layouts',
      label: 'Layouts',
      items: [
        ...LAYOUT_PRESETS.map((p) => ({
          id: `lay-${p.id}`,
          label: p.label,
          onSelect: () => runCommand(`layout.${p.id}`),
        })),
        sep('l1'),
        { id: 'split-r', label: 'Split right', onSelect: () => runCommand('split-right') },
        { id: 'split-d', label: 'Split down', onSelect: () => runCommand('split-down') },
        { id: 'detach', label: 'Detach (floating)', onSelect: () => runCommand('detach') },
      ],
    },
    {
      kind: 'submenu',
      id: 'linked',
      label: 'Create linked window',
      items: [
        ...CHART_TEMPLATES.map((t) => ({
          id: `lk-${t.id}`,
          label: t.label,
          onSelect: () => openLinkedWindow(id, 'chart', t.id),
        })),
        { id: 'lk-dom', label: 'DOM', onSelect: () => openLinkedWindow(id, 'dom') },
      ],
    },
    { id: 'clone', label: 'Clone window', onSelect: () => cloneWindow(id) },
    {
      id: 'hide-panels',
      label: 'Hide panels',
      checked: sBool(s, 'other.hidePanels'),
      onSelect: set('other.hidePanels', !sBool(s, 'other.hidePanels')),
    },
    sep('s5'),
    { kind: 'submenu', id: 'session', label: 'Trading session', items: sessionItems },
    { id: 'refresh', label: 'Refresh', onSelect: act('refresh') },
    { id: 'reload', label: 'Reload all historical data', onSelect: act('reload-history') },
    { id: 'reset', label: 'Reset', shortcut: 'Ctrl+R', onSelect: act('reset') },
    {
      kind: 'submenu',
      id: 'export',
      label: 'Export…',
      items: [
        { id: 'png', label: 'PNG image', onSelect: act('export-png') },
        { id: 'csv', label: 'CSV of bars', onSelect: act('export-csv') },
        { id: 'csvc', label: 'CSV of clusters', onSelect: act('export-clusters') },
        { id: 'json', label: 'JSON of bars', onSelect: act('export-json') },
        { id: 'tjson', label: 'Template JSON', onSelect: act('export-template') },
      ],
    },
    sep('s6'),
    {
      id: 'datawin',
      label: 'Data window',
      checked: sBool(s, 'crosshair.dataWindow'),
      onSelect: set('crosshair.dataWindow', !sBool(s, 'crosshair.dataWindow')),
    },
    {
      id: 'pin',
      label: 'Pin (keep instrument)',
      checked: c.ext.pinned === true,
      onSelect: () => patchChartExt(id, { pinned: !c.ext.pinned }),
    },
    {
      id: 'fullscreen',
      label: 'Full screen mode',
      shortcut: 'Ctrl+dbl-click',
      onSelect: act('fullscreen'),
    },
    {
      id: 'settings',
      label: 'Settings…',
      shortcut: 'Ctrl+S',
      onSelect: () => openChartSettings(id),
    },
  ];
}
