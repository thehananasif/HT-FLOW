import { translateLiteral } from '@htflow/i18n';

/** Ribbon modules and the build phase that delivers each full screen (docs/FEATURES.md). */
export interface ModuleDef {
  id: string;
  label: string;
  group: 'Analysis' | 'Platform' | 'Social / Tools' | 'Tables' | 'Market Analytics' | 'Info';
  phase: string;
  hasMenu?: boolean;
}

const MODULE_DEFS: ModuleDef[] = [
  {
    id: 'chart',
    label: 'Chart',
    group: 'Analysis',
    phase: 'P08–P10, P46',
    hasMenu: true,
  },
  { id: 'watchlist', label: 'Watchlist', group: 'Analysis', phase: 'P41' },
  {
    id: 'smart-dom',
    label: 'Smart DOM',
    group: 'Analysis',
    phase: 'P15',
    hasMenu: true,
  },
  { id: 'smart-tape', label: 'Smart Tape', group: 'Analysis', phase: 'P16' },
  { id: 'bidask-tape', label: 'Bid/Ask Tape', group: 'Analysis', phase: 'P16' },
  { id: 'all-prices', label: 'All Prices', group: 'Analysis', phase: 'P16' },
  { id: 'options-board', label: 'Options Board', group: 'Analysis', phase: 'P18' },
  { id: 'heatmap', label: 'Heatmap', group: 'Analysis', phase: 'P11' },
  { id: 'forward-curve', label: 'Forward curve', group: 'Analysis', phase: 'P19 / P41' },
  { id: 'connections', label: 'Connections', group: 'Platform', phase: 'P32' },
  { id: 'data-manager', label: 'Data manager', group: 'Platform', phase: 'P06' },
  { id: 'workspaces', label: 'Workspaces', group: 'Platform', phase: 'P25 / P37', hasMenu: true },
  { id: 'layout-settings', label: 'Layout Settings', group: 'Platform', phase: 'P37' },
  { id: 'alerts', label: 'Alerts', group: 'Platform', phase: 'P23 / P41', hasMenu: true },
  { id: 'risk', label: 'Risk', group: 'Platform', phase: 'P23 / P41', hasMenu: true },
  { id: 'replay', label: 'Replay', group: 'Social / Tools', phase: 'P24 / P35', hasMenu: true },
  { id: 'web-pages', label: 'Web Pages', group: 'Social / Tools', phase: 'P28', hasMenu: true },
  { id: 'logs', label: 'Logs', group: 'Social / Tools', phase: 'P28', hasMenu: true },
  { id: 'user-guide', label: 'User Guide', group: 'Social / Tools', phase: 'P28' },
  { id: 'ai', label: 'AI', group: 'Social / Tools', phase: 'R7' },
  { id: 'drawing-objects', label: 'Objects List', group: 'Analysis', phase: 'P12' },
  { id: 'accounts', label: 'Accounts', group: 'Tables', phase: 'P40' },
  { id: 'positions', label: 'Positions', group: 'Tables', phase: 'P40' },
  { id: 'orders', label: 'Orders', group: 'Tables', phase: 'P40' },
  { id: 'trades', label: 'Trades', group: 'Tables', phase: 'P40' },
  { id: 'activity', label: 'Trading Activity', group: 'Tables', phase: 'P40' },
  { id: 'journal', label: 'Journal', group: 'Tables', phase: 'P36' },
  { id: 'strategies', label: 'Strategies', group: 'Tables', phase: 'P42' },
  { id: 'market-pressure', label: 'Market Pressure', group: 'Market Analytics', phase: 'P38' },
  { id: 'price-change', label: 'Price Change', group: 'Market Analytics', phase: 'P38' },
  { id: 'dom-pressure', label: 'DOM Pressure', group: 'Market Analytics', phase: 'P38' },
  { id: 'delta-divergence', label: 'Delta Divergence', group: 'Market Analytics', phase: 'P38' },
  { id: 'rss', label: 'RSS Reader', group: 'Info', phase: 'P39', hasMenu: true },
  { id: 'news', label: 'News', group: 'Info', phase: 'P39', hasMenu: true },
  { id: 'calendar', label: 'Calendar', group: 'Info', phase: 'P39', hasMenu: true },
];

/** Ribbon modules; `label` resolves in the active language when read (`group` stays the raw key). */
export const MODULES: ModuleDef[] = MODULE_DEFS.map((m) => ({
  ...m,
  get label() {
    return translateLiteral(m.label);
  },
}));

export function moduleDef(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}

// Whether a module has a real window is decided by modules/registry.ts (isModuleBuilt).
