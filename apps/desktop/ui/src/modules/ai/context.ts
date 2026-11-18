/**
 * Structured "what is on my screen" text sent with a question: active symbol, timeframe, last
 * prices, indicators, positions, P&L and recent order-flow stats. Only data the app already has.
 */
import type { TimeframeSpec } from '@htflow/workspace';
import { hub, paper } from '../../state/market';
import { useWindows } from '../../state/windows';
import { flowStats } from './tools';

export function timeframeText(tf: TimeframeSpec | undefined): string {
  if (!tf) return 'unknown';
  switch (tf.kind) {
    case 'time': {
      const s = tf.ms / 1000;
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${s / 60}m`;
      if (s < 86400) return `${s / 3600}h`;
      return `${s / 86400}D`;
    }
    case 'tick':
    case 'volume':
    case 'delta':
    case 'orderflow':
      return `${tf.n} ${tf.kind}`;
    case 'range':
    case 'rangex':
    case 'rangez':
    case 'rangexv':
      return `${tf.ticks}-tick ${tf.kind}`;
    default:
      return tf.kind;
  }
}

export interface ScreenSnapshot {
  symbol: string | null;
  instrumentId: string | null;
  timeframe: string;
  chartType: string | null;
  indicators: string[];
  last: number | null;
  bid: number | null;
  ask: number | null;
  flow: ReturnType<typeof flowStats> | null;
  account: { name: string; kind: string; balance: number; currency: string } | null;
  positions: { instrument: string; qty: number; avgPrice: number; unrealized: number | null }[];
  workingOrders: number;
  openWindows: string[];
}

/** Plain-text rendering (stable order, compact). */
export function formatContext(s: ScreenSnapshot, now = Date.now()): string {
  const L: string[] = [];
  L.push(`time: ${new Date(now).toISOString()}`);
  L.push(`active instrument: ${s.symbol ?? 'none'}${s.instrumentId ? ` (${s.instrumentId})` : ''}`);
  L.push(`timeframe: ${s.timeframe}${s.chartType ? `, chart type: ${s.chartType}` : ''}`);
  if (s.indicators.length) L.push(`indicators: ${s.indicators.join(', ')}`);
  L.push(`last: ${s.last ?? '—'}  bid: ${s.bid ?? '—'}  ask: ${s.ask ?? '—'}`);
  if (s.flow) {
    const f = s.flow;
    L.push(
      `order flow (15 min): buy ${f.buyVolume}, sell ${f.sellVolume}, delta ${f.delta}, trades ${f.trades}, POC ${f.poc ?? '—'}`,
    );
    if (f.largePrints.length)
      L.push(
        `large prints: ${f.largePrints
          .slice(-5)
          .map((p) => `${p.side} ${p.qty}@${p.price}`)
          .join(', ')}`,
      );
  }
  if (s.account)
    L.push(
      `account: ${s.account.name} (${s.account.kind}) balance ${s.account.balance.toFixed(2)} ${s.account.currency}`,
    );
  L.push(
    s.positions.length
      ? `positions: ${s.positions.map((p) => `${p.instrument} ${p.qty} @ ${p.avgPrice} (uPnL ${p.unrealized ?? '—'})`).join('; ')}`
      : 'positions: flat',
  );
  L.push(`working orders: ${s.workingOrders}`);
  if (s.openWindows.length) L.push(`open windows: ${s.openWindows.join(', ')}`);
  return L.join('\n');
}

const round = (v: number) => Number(v.toFixed(8));

export function collectSnapshot(accountId: string, now = Date.now()): ScreenSnapshot {
  const { windows, activeId } = useWindows.getState();
  const active =
    (activeId && windows[activeId]?.kind !== 'module' ? windows[activeId] : undefined) ??
    Object.values(windows).find((w) => w.kind === 'chart') ??
    Object.values(windows).find((w) => w.kind !== 'module');
  const instrumentId = active && 'instrumentId' in active ? active.instrumentId : null;
  const store = instrumentId ? hub.peek(instrumentId) : undefined;
  const tick = store?.instrument.tickSize ?? 1;
  const px = (v: number | undefined) =>
    v === undefined || !Number.isFinite(v) ? null : round(v * tick);
  const chart = active?.kind === 'chart' ? active : null;
  const indExt = chart?.ext?.indicators as { items?: { id?: string; name?: string }[] } | undefined;
  const acc = paper.accounts.get(accountId);
  const trades = store ? store.trades.filter((t) => t.ts >= now - 15 * 60_000) : [];
  return {
    symbol: store?.instrument.symbol ?? instrumentId,
    instrumentId,
    timeframe: chart ? timeframeText(chart.timeframe) : 'n/a',
    chartType: chart?.template ?? null,
    indicators: (indExt?.items ?? []).map((i) => i.name ?? i.id ?? '?').slice(0, 30),
    last: px(store?.lastTrade?.px),
    bid: px(store?.book.bestBid),
    ask: px(store?.book.bestAsk),
    flow: store && trades.length ? flowStats(trades, tick) : null,
    account: acc
      ? { name: acc.name, kind: acc.kind, balance: acc.balance, currency: acc.currency }
      : null,
    positions: paper.allPositions(accountId).map((p) => {
      const s = hub.peek(p.instrumentId);
      const t = s?.instrument.tickSize ?? 1;
      const m = s?.lastTrade?.px;
      return {
        instrument: p.instrumentId,
        qty: p.qty,
        avgPrice: round(p.avgPx * t),
        unrealized:
          m !== undefined
            ? Number(paper.unrealized(accountId, p.instrumentId, m).toFixed(2))
            : null,
      };
    }),
    workingOrders: paper.workingOrders(accountId).length,
    openWindows: Object.values(windows)
      .map((w) => (w.kind === 'module' ? w.module : `${w.kind}:${w.instrumentId}`))
      .slice(0, 20),
  };
}
