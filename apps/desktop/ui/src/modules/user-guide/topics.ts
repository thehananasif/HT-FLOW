import { useSyncExternalStore } from 'react';

/** A place in the guide: article id and optional heading anchor. */
export interface GuideTarget {
  article: string;
  anchor?: string;
}

/** Guide topic for each module window ("Help for this panel"). */
const MODULE_TOPICS: Record<string, GuideTarget> = {
  chart: { article: 'charts' },
  watchlist: { article: 'scanners', anchor: 'watchlists' },
  'smart-dom': { article: 'order-flow', anchor: 'smart-dom' },
  'smart-tape': { article: 'order-flow', anchor: 'time-and-sales-smart-tape' },
  'bidask-tape': { article: 'order-flow', anchor: 'time-and-sales-smart-tape' },
  'all-prices': { article: 'order-flow', anchor: 'time-and-sales-smart-tape' },
  'options-board': { article: 'scanners', anchor: 'options-board-and-forward-curve' },
  heatmap: { article: 'order-flow', anchor: 'heatmap-liquidity-map' },
  'forward-curve': { article: 'scanners', anchor: 'options-board-and-forward-curve' },
  connections: { article: 'data' },
  'data-manager': { article: 'data-manager' },
  workspaces: { article: 'interface', anchor: 'workspaces-and-layouts' },
  'layout-settings': { article: 'interface', anchor: 'workspaces-and-layouts' },
  alerts: { article: 'alerts' },
  risk: { article: 'trading', anchor: 'risk-limits' },
  replay: { article: 'replay' },
  'web-pages': { article: 'news' },
  logs: { article: 'backups-logs', anchor: 'logs' },
  'drawing-objects': { article: 'charts', anchor: 'drawing-tools' },
  accounts: { article: 'trading', anchor: 'positions-orders-and-tables' },
  positions: { article: 'trading', anchor: 'positions-orders-and-tables' },
  orders: { article: 'trading', anchor: 'positions-orders-and-tables' },
  trades: { article: 'trading', anchor: 'positions-orders-and-tables' },
  activity: { article: 'trading', anchor: 'positions-orders-and-tables' },
  journal: { article: 'trading', anchor: 'trading-journal' },
  strategies: { article: 'strategies' },
  'market-pressure': { article: 'scanners', anchor: 'market-scanners' },
  'price-change': { article: 'scanners', anchor: 'market-scanners' },
  'dom-pressure': { article: 'scanners', anchor: 'market-scanners' },
  'delta-divergence': { article: 'scanners', anchor: 'market-scanners' },
  rss: { article: 'news', anchor: 'rss-reader' },
  news: { article: 'news', anchor: 'news' },
  calendar: { article: 'news', anchor: 'economic-calendar' },
  'user-guide': { article: 'getting-started' },
  'script-editor': { article: 'charts', anchor: 'indicators' },
};

const CHART_TOPICS: Record<string, GuideTarget> = {
  footprint: { article: 'order-flow', anchor: 'footprint' },
  'order-flow-dark': { article: 'order-flow', anchor: 'footprint' },
  'order-flow-light': { article: 'order-flow', anchor: 'footprint' },
  imbalance: { article: 'order-flow', anchor: 'footprint' },
  'liquidity-map': { article: 'order-flow', anchor: 'heatmap-liquidity-map' },
  'onchart-liquidity': { article: 'order-flow', anchor: 'heatmap-liquidity-map' },
  'candles-vp': { article: 'order-flow', anchor: 'volume-profile' },
  tpo: { article: 'order-flow', anchor: 'volume-profile' },
  'delta-profile': { article: 'order-flow', anchor: 'volume-profile' },
};

/** Guide target for a window state (chart template, DOM, or module id). */
export function helpTopicFor(s: { kind: string; template?: string; module?: string }): GuideTarget {
  if (s.kind === 'dom') return { article: 'order-flow', anchor: 'smart-dom' };
  if (s.kind === 'chart') return (s.template && CHART_TOPICS[s.template]) || { article: 'charts' };
  return (s.module && MODULE_TOPICS[s.module]) || { article: 'getting-started' };
}

// ------------------------------------------------------------------ navigation requests

let pending: GuideTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens (or focuses) the User Guide window, optionally at an article / heading. */
export function openGuide(target?: GuideTarget): void {
  pending = target ?? null;
  emit();
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'user-guide' }));
}

export function consumeGuideRequest(): GuideTarget | null {
  const p = pending;
  pending = null;
  return p;
}

/** Re-renders the guide when a navigation request is waiting. */
export function useGuideRequest(): GuideTarget | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pending,
  );
}
