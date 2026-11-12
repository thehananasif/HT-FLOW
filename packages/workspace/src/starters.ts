/**
 * Starter workspaces (P25): ready-made workspaces the user can load or copy into the library.
 * Each layout is described as PanelSpecs; the Dashboard builds the dockview layout from them.
 */
import {
  chartState,
  domState,
  type PanelSpec,
  type WindowState,
  type WorkspaceDoc,
  type WorkspaceTab,
} from './model';

export interface StarterWorkspace {
  id: string;
  name: string;
  description: string;
  build(): WorkspaceDoc;
}

const mod = (module: string, params?: Record<string, unknown>): WindowState =>
  params ? { kind: 'module', module, params } : { kind: 'module', module };

function tab(id: string, name: string, specs: PanelSpec[], tradingPanel = false): WorkspaceTab {
  const windows: Record<string, WindowState> = {};
  for (const s of specs) windows[s.id] = s.state;
  return { id, name, layout: null, windows, tradingPanel, specs };
}

function doc(name: string, tabs: WorkspaceTab[]): WorkspaceDoc {
  return { version: 1, name, activeTab: tabs[0]!.id, tabs, savedAt: 0 };
}

const NQ = 'mock:NQZ6';
const ES = 'mock:ESZ6';
const CL = 'mock:CLZ6';
const GC = 'mock:GCZ6';
const BTC = 'mock:BTCUSDT';

export const STARTER_WORKSPACES: StarterWorkspace[] = [
  {
    id: 'starter-scalping-nq',
    name: 'Scalping NQ',
    description:
      'NQ DOM, footprint and Smart Tape, all on the blue link group, Trading panel open.',
    build: () =>
      doc('Scalping NQ', [
        tab(
          'scalp',
          'Scalping',
          [
            { id: 'dom-1', state: domState(NQ, { link: 'blue' }) },
            {
              id: 'chart-1',
              state: chartState(NQ, 'footprint', {
                link: 'blue',
                timeframe: { kind: 'time', ms: 60_000 },
              }),
              position: { ref: 'dom-1', dir: 'right' },
              size: 0.65,
            },
            {
              id: 'tape-1',
              state: mod('smart-tape', { instrumentId: NQ }),
              position: { ref: 'chart-1', dir: 'right' },
              size: 0.3,
            },
          ],
          true,
        ),
      ]),
  },
  {
    id: 'starter-crypto-flow',
    name: 'Crypto Flow',
    description: 'BTC footprint, liquidity map and order flow with a DOM, linked green.',
    build: () =>
      doc('Crypto Flow', [
        tab('crypto', 'Crypto', [
          { id: 'chart-1', state: chartState(BTC, 'footprint', { link: 'green' }) },
          {
            id: 'chart-2',
            state: chartState(BTC, 'liquidity-map', { link: 'green' }),
            position: { ref: 'chart-1', dir: 'right' },
            size: 0.4,
          },
          {
            id: 'dom-1',
            state: domState(BTC, { link: 'green' }),
            position: { ref: 'chart-2', dir: 'below' },
          },
          {
            id: 'chart-3',
            state: chartState(BTC, 'order-flow-dark', { link: 'green' }),
            position: { ref: 'chart-1', dir: 'below' },
            size: 0.35,
          },
        ]),
      ]),
  },
  {
    id: 'starter-futures',
    name: 'Futures',
    description: 'ES, NQ, CL and GC candles with volume profile, plus Watchlist and Positions.',
    build: () =>
      doc('Futures', [
        tab('fut', 'Futures', [
          { id: 'chart-1', state: chartState(ES, 'candles-vp', { link: 'red' }) },
          {
            id: 'chart-2',
            state: chartState(NQ, 'candles-vp', { link: 'yellow' }),
            position: { ref: 'chart-1', dir: 'right' },
          },
          {
            id: 'chart-3',
            state: chartState(CL, 'candles-vp', { link: 'purple' }),
            position: { ref: 'chart-1', dir: 'below' },
          },
          {
            id: 'chart-4',
            state: chartState(GC, 'candles-vp'),
            position: { ref: 'chart-2', dir: 'below' },
          },
          {
            id: 'watch-1',
            state: mod('watchlist'),
            position: { ref: 'chart-2', dir: 'right' },
            size: 0.22,
          },
          {
            id: 'pos-1',
            state: mod('positions'),
            position: { ref: 'watch-1', dir: 'below' },
          },
        ]),
      ]),
  },
  {
    id: 'starter-multichart',
    name: 'Multi-Chart 2×2',
    description: 'ES · NQ · CL · GC footprints in a 2×2 grid.',
    build: () =>
      doc('Multi-Chart 2×2', [
        tab('grid', 'Grid', [
          { id: 'chart-1', state: chartState(ES, 'footprint') },
          {
            id: 'chart-2',
            state: chartState(NQ, 'footprint'),
            position: { ref: 'chart-1', dir: 'right' },
          },
          {
            id: 'chart-3',
            state: chartState(CL, 'footprint'),
            position: { ref: 'chart-1', dir: 'below' },
          },
          {
            id: 'chart-4',
            state: chartState(GC, 'footprint'),
            position: { ref: 'chart-2', dir: 'below' },
          },
        ]),
      ]),
  },
  {
    id: 'starter-heatmap-dom',
    name: 'Heatmap + DOM',
    description: 'Large liquidity map with a linked DOM and tape.',
    build: () =>
      doc('Heatmap + DOM', [
        tab(
          'heat',
          'Heatmap',
          [
            { id: 'chart-1', state: chartState(ES, 'liquidity-map', { link: 'purple' }) },
            {
              id: 'dom-1',
              state: domState(ES, { link: 'purple' }),
              position: { ref: 'chart-1', dir: 'right' },
              size: 0.28,
            },
            {
              id: 'tape-1',
              state: mod('smart-tape', { instrumentId: ES }),
              position: { ref: 'dom-1', dir: 'below' },
            },
          ],
          true,
        ),
      ]),
  },
  {
    id: 'starter-options-desk',
    name: 'Options Desk',
    description: 'Options board, forward curve and a candles chart.',
    build: () =>
      doc('Options Desk', [
        tab('opt', 'Options', [
          { id: 'opt-1', state: mod('options-board') },
          {
            id: 'chart-1',
            state: chartState(BTC, 'candles-vp'),
            position: { ref: 'opt-1', dir: 'right' },
            size: 0.4,
          },
          {
            id: 'curve-1',
            state: mod('forward-curve'),
            position: { ref: 'chart-1', dir: 'below' },
          },
        ]),
      ]),
  },
  {
    id: 'starter-analysis',
    name: 'Analysis',
    description: 'Charts with market analytics, news and the economic calendar (two layouts).',
    build: () =>
      doc('Analysis', [
        tab('charts', 'Charts', [
          { id: 'chart-1', state: chartState(ES, 'candles-vp', { link: 'blue' }) },
          {
            id: 'mp-1',
            state: mod('market-pressure'),
            position: { ref: 'chart-1', dir: 'right' },
            size: 0.3,
          },
          {
            id: 'pc-1',
            state: mod('price-change'),
            position: { ref: 'mp-1', dir: 'below' },
          },
          {
            id: 'dd-1',
            state: mod('delta-divergence'),
            position: { ref: 'chart-1', dir: 'below' },
            size: 0.35,
          },
        ]),
        tab('info', 'News & calendar', [
          { id: 'news-1', state: mod('news') },
          {
            id: 'cal-1',
            state: mod('calendar'),
            position: { ref: 'news-1', dir: 'right' },
          },
        ]),
      ]),
  },
  {
    id: 'starter-replay',
    name: 'Replay practice',
    description: 'Replay controller, a footprint on the replay feed and the trading journal.',
    build: () =>
      doc('Replay practice', [
        tab(
          'replay',
          'Replay',
          [
            { id: 'chart-1', state: chartState(CL, 'footprint', { link: 'yellow' }) },
            {
              id: 'replay-1',
              state: mod('replay'),
              position: { ref: 'chart-1', dir: 'below' },
              size: 0.3,
            },
            {
              id: 'journal-1',
              state: mod('journal'),
              position: { ref: 'chart-1', dir: 'right' },
              size: 0.3,
            },
          ],
          true,
        ),
      ]),
  },
];

export function starterById(id: string): StarterWorkspace | undefined {
  return STARTER_WORKSPACES.find((s) => s.id === id);
}
