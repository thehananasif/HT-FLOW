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
import { t } from '@htflow/i18n';
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
import { slotExtensionItems } from './menuSlots';

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
  /** Trading lock of the routed paper account for this instrument. */
  locked: boolean;
  toggleLock(): void;
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
      { value: 'linear', label: t('chartMenu.linear') },
      { value: 'log', label: t('chartMenu.log') },
      { value: 'percent', label: t('chartMenu.percent') },
      { value: 'indexed', label: t('chartMenu.indexed') },
    ]),
    sep('sc1'),
    {
      id: 'invert',
      label: t('chartMenu.invertScale'),
      shortcut: 'Alt+I',
      checked: sBool(s, 'scales.invert'),
      onSelect: set('scales.invert', !sBool(s, 'scales.invert')),
    },
    {
      id: 'autofit',
      label: t('chartMenu.autoFit'),
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
      label: t('chartMenu.priceAxis'),
      items: choice('scales.side', 'side', [
        { value: 'right', label: t('chartMenu.right') },
        { value: 'left', label: t('chartMenu.left') },
        { value: 'both', label: t('chartMenu.both') },
      ]),
    },
    {
      id: 'scale-settings',
      label: t('chartMenu.scaleSettings'),
      onSelect: () => openChartSettings(id),
    },
  ];

  const tzItems = choice('scales.timeZone', 'tz', TIME_ZONES);
  const sessionItems = choice('session.trading', 'sess', TRADING_SESSIONS);

  if (c.hit.area === 'price-axis') {
    return [{ kind: 'label', id: 'l', label: t('chartMenu.priceScale') }, ...scaleItems];
  }
  if (c.hit.area === 'time-axis') {
    return [
      { kind: 'label', id: 'l', label: t('chartMenu.timeAxis') },
      { kind: 'submenu', id: 'tz', label: t('chartMenu.timeZone'), items: tzItems },
      { kind: 'submenu', id: 'sess', label: t('chartMenu.tradingSession'), items: sessionItems },
      {
        id: 'gaps',
        label: t('chartMenu.showTimeGaps'),
        checked: sBool(s, 'scales.gaps'),
        onSelect: set('scales.gaps', !sBool(s, 'scales.gaps')),
      },
      ...choice('scales.timeFormat', 'tf', [
        { value: '24h', label: t('chartMenu.time24') },
        { value: '12h', label: t('chartMenu.time12') },
      ]),
      sep('t1'),
      {
        id: 'goto',
        label: t('chartMenu.goToDate'),
        shortcut: 'Ctrl+G',
        onSelect: act('goto-date'),
      },
      { id: 'reset', label: t('chartMenu.reset'), shortcut: 'Ctrl+R', onSelect: act('reset') },
    ];
  }
  if ((c.hit.area === 'pane' || c.hit.area === 'separator') && c.hit.layerId) {
    const layerId = c.hit.layerId;
    const layer = c.handle?.main.layers.find((l) => l.id === layerId);
    const maximised = c.handle?.main.maximizedPane === layerId;
    return [
      { kind: 'label', id: 'l', label: t('chartMenu.pane', { name: layer?.paneLabel ?? layerId }) },
      {
        id: 'max',
        label: maximised ? t('chartMenu.restorePane') : t('chartMenu.maximizePane'),
        onSelect: () => c.handle?.main.toggleMaximizePane(layerId),
      },
      {
        id: 'reset-panes',
        label: t('chartMenu.resetPaneHeights'),
        onSelect: () => {
          c.handle?.main.resetPanes();
          patchChartExt(id, { panes: {} });
        },
      },
      ...(layerId === 'volume-pane'
        ? [
            {
              id: 'hide-vol',
              label: t('chartMenu.hideVolumePane'),
              onSelect: set('volume.pane', false),
            },
          ]
        : []),
      ...slotExtensionItems(c.extensionItems).context,
      sep('p1'),
      {
        id: 'settings',
        label: t('chartMenu.settings'),
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
                    label: t('chartMenu.sellLimitAt', { price: priceLabel }),
                    onSelect: () => c.order('sell', 'limit'),
                  }
                : {
                    id: 'bl',
                    label: t('chartMenu.buyLimitAt', { price: priceLabel }),
                    onSelect: () => c.order('buy', 'limit'),
                  },
            ]
          : []),
        ...(tradeMode !== 'limit'
          ? [
              above
                ? {
                    id: 'bs',
                    label: t('chartMenu.buyStopAt', { price: priceLabel }),
                    onSelect: () => c.order('buy', 'stop'),
                  }
                : {
                    id: 'ss',
                    label: t('chartMenu.sellStopAt', { price: priceLabel }),
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
    { kind: 'label', id: 'tb', label: t('chartMenu.builtInTypes') },
    ...CHART_TEMPLATES.map((t) => ({
      id: `b-${t.id}`,
      label: t.label,
      checked: c.state.template === t.id,
      onSelect: () => useWindows.getState().patch(id, { template: t.id } as Partial<WindowState>),
    })),
    ...(favs.length
      ? [
          sep('tf'),
          { kind: 'label' as const, id: 'tfl', label: t('chartMenu.favourites') },
          ...favs.map(tplItem),
        ]
      : []),
    ...(users.length
      ? [
          sep('tu'),
          { kind: 'label' as const, id: 'tul', label: t('chartMenu.myTemplates') },
          ...users.map(tplItem),
        ]
      : []),
    sep('tp'),
    {
      kind: 'submenu',
      id: 'presets',
      label: t('chartMenu.stylePresets'),
      items: presets.map(tplItem),
    },
    sep('ts'),
    { id: 'save-tpl', label: t('chartMenu.saveTemplate'), onSelect: act('save-template') },
    {
      id: 'export-tpl',
      label: t('chartMenu.exportTemplateJson'),
      onSelect: act('export-template'),
    },
    {
      id: 'manage-tpl',
      label: t('chartMenu.manageTemplates'),
      onSelect: () => useChartSettingsUi.getState().open(id, 'templates'),
    },
  ];

  const compare = c.ext.compare ?? [];
  const overlay: MenuEntry[] = [
    { id: 'ov-add', label: t('chartMenu.addInstrument'), onSelect: act('overlay') },
    ...compare.map((o) => ({
      id: `ov-${o.instrumentId}`,
      label: t('chartMenu.removeOverlay', { symbol: o.instrumentId.split(':').pop() ?? '' }),
      onSelect: () =>
        patchChartExt(id, { compare: compare.filter((x) => x.instrumentId !== o.instrumentId) }),
    })),
    ...(compare.length
      ? [
          {
            id: 'ov-clear',
            label: t('chartMenu.removeAllOverlays'),
            onSelect: act('clear-overlays'),
          },
        ]
      : []),
  ];

  const mouseItems: MenuEntry[] = [
    ...choice('crosshair.mouseMode', 'mm', MOUSE_MODES.slice(0, 2)),
    {
      id: 'mm-global',
      label: t('chartMenu.globalCrosshair'),
      checked: sStr(s, 'crosshair.sync') === 'global',
      onSelect: set('crosshair.sync', sStr(s, 'crosshair.sync') === 'global' ? 'off' : 'global'),
    },
    {
      id: 'mm-sync',
      label: t('chartMenu.syncCrosshair'),
      checked: sStr(s, 'crosshair.sync') === 'link',
      onSelect: set('crosshair.sync', sStr(s, 'crosshair.sync') === 'link' ? 'off' : 'link'),
    },
    ...choice('crosshair.mouseMode', 'mm', MOUSE_MODES.slice(2)),
  ];

  const ex = slotExtensionItems(c.extensionItems);
  const group = (id: string, items: MenuEntry[]): MenuEntry[] =>
    items.length ? [...items, sep(id)] : [];

  return [
    ...group('s0', ex.context),
    ...tradeItems,
    ...ex.trade,
    sep('s1'),
    {
      id: 'tp',
      label: t('chartMenu.tradingPanel'),
      shortcut: 'T',
      onSelect: () => useWindows.getState().setTradingPanel(!useWindows.getState().tradingPanel),
    },
    {
      id: 'domt',
      label: t('chartMenu.domTrader'),
      checked: c.domTrader,
      onSelect: c.toggleDomTrader,
    },
    { id: 'lock', label: t('chartMenu.lockTrading'), checked: c.locked, onSelect: c.toggleLock },
    ...ex.trading,
    sep('s2'),
    { id: 'goto', label: t('chartMenu.goToDate'), shortcut: 'Ctrl+G', onSelect: act('goto-date') },
    { id: 'chg-inst', label: t('chartMenu.changeInstrument'), onSelect: act('change-instrument') },
    {
      kind: 'submenu',
      id: 'mode',
      label: t('chartMenu.mode'),
      items: [
        {
          kind: 'submenu',
          id: 'fp',
          label: t('chartMenu.footprint'),
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
              label: t('chartMenu.footprintSettings'),
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
    { kind: 'submenu', id: 'mouse', label: t('chartMenu.mouse'), items: mouseItems },
    { kind: 'submenu', id: 'scale', label: t('chartMenu.priceScale'), items: scaleItems },
    sep('s3'),
    { kind: 'submenu', id: 'templates', label: t('chartMenu.templates'), items: templates },
    ...ex.indicators,
    { kind: 'submenu', id: 'overlay', label: t('chartMenu.overlay'), items: overlay },
    ...ex.drawing,
    ...ex.strategies,
    sep('s4'),
    {
      kind: 'submenu',
      id: 'layouts',
      label: t('chartMenu.layouts'),
      items: [
        ...LAYOUT_PRESETS.map((p) => ({
          id: `lay-${p.id}`,
          label: p.label,
          onSelect: () => runCommand(`layout.${p.id}`),
        })),
        sep('l1'),
        {
          id: 'split-r',
          label: t('chartMenu.splitRight'),
          onSelect: () => runCommand('split-right'),
        },
        {
          id: 'split-d',
          label: t('chartMenu.splitDown'),
          onSelect: () => runCommand('split-down'),
        },
        { id: 'detach', label: t('chartMenu.detach'), onSelect: () => runCommand('detach') },
      ],
    },
    {
      kind: 'submenu',
      id: 'linked',
      label: t('chartMenu.createLinked'),
      items: [
        ...CHART_TEMPLATES.map((t) => ({
          id: `lk-${t.id}`,
          label: t.label,
          onSelect: () => openLinkedWindow(id, 'chart', t.id),
        })),
        { id: 'lk-dom', label: t('chartMenu.dom'), onSelect: () => openLinkedWindow(id, 'dom') },
      ],
    },
    { id: 'clone', label: t('chartMenu.cloneWindow'), onSelect: () => cloneWindow(id) },
    {
      id: 'hide-panels',
      label: t('chartMenu.hidePanels'),
      checked: sBool(s, 'other.hidePanels'),
      onSelect: set('other.hidePanels', !sBool(s, 'other.hidePanels')),
    },
    sep('s5'),
    { kind: 'submenu', id: 'session', label: t('chartMenu.tradingSession'), items: sessionItems },
    { id: 'refresh', label: t('chartMenu.refresh'), onSelect: act('refresh') },
    { id: 'reload', label: t('chartMenu.reloadHistory'), onSelect: act('reload-history') },
    ...ex.replay,
    { id: 'reset', label: t('chartMenu.reset'), shortcut: 'Ctrl+R', onSelect: act('reset') },
    {
      kind: 'submenu',
      id: 'export',
      label: t('chartMenu.export'),
      items: [
        { id: 'png', label: t('chartMenu.exportPng'), onSelect: act('export-png') },
        { id: 'csv', label: t('chartMenu.exportCsvBars'), onSelect: act('export-csv') },
        { id: 'csvc', label: t('chartMenu.exportCsvClusters'), onSelect: act('export-clusters') },
        { id: 'json', label: t('chartMenu.exportJsonBars'), onSelect: act('export-json') },
        {
          id: 'tjson',
          label: t('chartMenu.exportTemplateShort'),
          onSelect: act('export-template'),
        },
      ],
    },
    sep('s6'),
    ...ex.more,
    {
      id: 'datawin',
      label: t('chartMenu.dataWindow'),
      checked: sBool(s, 'crosshair.dataWindow'),
      onSelect: set('crosshair.dataWindow', !sBool(s, 'crosshair.dataWindow')),
    },
    {
      id: 'pin',
      label: t('chartMenu.pin'),
      checked: c.ext.pinned === true,
      onSelect: () => patchChartExt(id, { pinned: !c.ext.pinned }),
    },
    {
      id: 'fullscreen',
      label: t('chartMenu.fullScreen'),
      shortcut: 'Ctrl+dbl-click',
      onSelect: act('fullscreen'),
    },
    {
      id: 'settings',
      label: t('chartMenu.settings'),
      shortcut: 'Ctrl+S',
      onSelect: () => openChartSettings(id),
    },
  ];
}
