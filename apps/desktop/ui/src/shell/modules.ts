/** Ribbon modules and the build phase that delivers each full screen (docs/FEATURES.md). */
export interface ModuleDef {
  id: string;
  label: string;
  group: 'Analysis' | 'Platform' | 'Social / Tools' | 'Tables' | 'Market Analytics' | 'Info';
  phase: string;
  hasMenu?: boolean;
  /** Built in this release (opens a real window rather than the module placeholder). */
  built?: boolean;
}

export const MODULES: ModuleDef[] = [
  {
    id: 'chart',
    label: 'Chart',
    group: 'Analysis',
    phase: 'P08–P10, P46',
    hasMenu: true,
    built: true,
  },
  { id: 'watchlist', label: 'Watchlist', group: 'Analysis', phase: 'P41' },
  {
    id: 'smart-dom',
    label: 'Smart DOM',
    group: 'Analysis',
    phase: 'P15',
    hasMenu: true,
    built: true,
  },
  { id: 'smart-tape', label: 'Smart Tape', group: 'Analysis', phase: 'P16' },
  { id: 'bidask-tape', label: 'Bid/Ask Tape', group: 'Analysis', phase: 'P16' },
  { id: 'all-prices', label: 'All Prices', group: 'Analysis', phase: 'P16' },
  { id: 'options-board', label: 'Options Board', group: 'Analysis', phase: 'P18' },
  { id: 'heatmap', label: 'Heatmap', group: 'Analysis', phase: 'P11', built: true },
  { id: 'forward-curve', label: 'Forward curve', group: 'Analysis', phase: 'P19 / P41' },
  { id: 'connections', label: 'Connections', group: 'Platform', phase: 'P32', built: true },
  { id: 'workspaces', label: 'Workspaces', group: 'Platform', phase: 'P25 / P37', hasMenu: true },
  { id: 'layout-settings', label: 'Layout Settings', group: 'Platform', phase: 'P37' },
  { id: 'alerts', label: 'Alerts', group: 'Platform', phase: 'P23 / P41', hasMenu: true },
  { id: 'risk', label: 'Risk', group: 'Platform', phase: 'P23 / P41', hasMenu: true },
  {
    id: 'following',
    label: 'Following Manager',
    group: 'Social / Tools',
    phase: 'P28',
    hasMenu: true,
  },
  { id: 'replay', label: 'Replay', group: 'Social / Tools', phase: 'P24 / P35', hasMenu: true },
  { id: 'web-pages', label: 'Web Pages', group: 'Social / Tools', phase: 'P28', hasMenu: true },
  { id: 'logs', label: 'Logs', group: 'Social / Tools', phase: 'P28', hasMenu: true },
  { id: 'accounts', label: 'Accounts', group: 'Tables', phase: 'P40', built: true },
  { id: 'positions', label: 'Positions', group: 'Tables', phase: 'P40', built: true },
  { id: 'orders', label: 'Orders', group: 'Tables', phase: 'P40', built: true },
  { id: 'trades', label: 'Trades', group: 'Tables', phase: 'P40', built: true },
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
  { id: 'traderstalk', label: 'TradersTalk', group: 'Info', phase: 'P22', hasMenu: true },
];

export function moduleDef(id: string): ModuleDef | undefined {
  return MODULES.find((m) => m.id === id);
}
