import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Checkbox } from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
import { hub } from '../../state/market';
import { collectSnapshot, type ContextInclude } from './context';
import { ai, agentDayPnlOfAccount, setInclude } from './runtime';
import { footprintRows, sparkline } from './thumb';

const SPAN = 5 * 60_000;

/** Re-renders every `ms` (live numbers). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return <div className="ai-thumb-empty">{t('ai.ctx.noData')}</div>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const w = 160;
  const h = 34;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      className={`ai-spark ${up ? 'is-up' : 'is-down'}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t('ai.ctx.sparkline')}
      data-testid="ai-ctx-spark"
    >
      <polyline points={pts} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Footprint({ rows }: { rows: { px: number; bid: number; ask: number }[] }) {
  if (!rows.length) return <div className="ai-thumb-empty">{t('ai.ctx.noData')}</div>;
  const max = Math.max(...rows.map((r) => Math.max(r.bid, r.ask)), 1e-9);
  const rowH = 9;
  const w = 160;
  const mid = w / 2;
  return (
    <svg
      className="ai-fp"
      viewBox={`0 0 ${w} ${rows.length * rowH}`}
      role="img"
      aria-label={t('ai.ctx.footprintThumb')}
      data-testid="ai-ctx-fp"
    >
      {rows.map((r, i) => (
        <g key={r.px}>
          <rect
            className="ai-fp-bid"
            x={mid - (r.bid / max) * (mid - 2)}
            y={i * rowH + 1}
            width={(r.bid / max) * (mid - 2)}
            height={rowH - 2}
          />
          <rect
            className="ai-fp-ask"
            x={mid + 1}
            y={i * rowH + 1}
            width={(r.ask / max) * (mid - 2)}
            height={rowH - 2}
          />
        </g>
      ))}
    </svg>
  );
}

function Row({
  part,
  label,
  children,
}: {
  part: keyof ContextInclude;
  label: string;
  children?: React.ReactNode;
}) {
  const on = ai.state().include[part];
  return (
    <section className={`ai-ctx-row${on ? '' : ' is-off'}`} data-testid={`ai-ctx-row-${part}`}>
      <div className="ai-ctx-head">
        <span data-testid={`ai-ctx-check-${part}`}>
          <Checkbox checked={on} onChange={(v) => setInclude({ [part]: v })} label={label} />
        </span>
      </div>
      {children && <div className="ai-ctx-body">{children}</div>}
    </section>
  );
}

/**
 * Right-hand panel: what the AI "sees", live. Each block has a checkbox; unchecked blocks are not
 * sent with the next message. Nothing is sent until the trader presses Send.
 */
export function ContextPanel() {
  useSyncExternalStore(ai.subscribe, ai.version);
  const now = useNow(500);
  const slow = Math.floor(now / 3000);
  const snap = useMemo(
    () => collectSnapshot(ai.state().agent.accountId),
    // 3 s refresh of the heavier snapshot (flow stats, positions); the price row ticks faster.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slow],
  );
  const id = snap.instrumentId;
  const store = id ? hub.peek(id) : undefined;
  const tick = store?.instrument.tickSize ?? 1;
  const prec = store?.instrument.pricePrecision ?? 2;
  const lastPx = store?.lastTrade?.px;
  const prev = useRef<number | undefined>(undefined);
  const dir = useRef<'up' | 'down' | ''>('');
  if (lastPx !== undefined && prev.current !== undefined && lastPx !== prev.current)
    dir.current = lastPx > prev.current ? 'up' : 'down';
  prev.current = lastPx;
  const spark = useMemo(
    () => (store ? sparkline(store.trades, now, SPAN, 40) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, slow, lastPx],
  );
  const fp = useMemo(
    () => (store ? footprintRows(store.trades, now, SPAN, 9) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, slow],
  );
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : v.toFixed(prec);
  const dayPnl = agentDayPnlOfAccount();
  const signed = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(2)}`;
  const flow = snap.flow;

  return (
    <aside className="ai-ctx col" data-testid="ai-context-panel" aria-label={t('ai.ctx.title')}>
      <header className="ai-ctx-title">
        <strong>{t('ai.ctx.title')}</strong>
        <span className="ai-live-dot" title={t('ai.ctx.live')} aria-hidden />
      </header>
      <p className="ai-hint">{t('ai.ctx.hint')}</p>
      <div className="ai-ctx-scroll">
        <Row part="symbol" label={t('ai.ctx.symbol')}>
          <span className="tnum ai-ctx-val" data-testid="ai-ctx-symbol" dir="ltr">
            {snap.symbol ?? '—'}
          </span>
        </Row>
        <Row part="timeframe" label={t('ai.ctx.timeframe')}>
          <span className="tnum ai-ctx-val" data-testid="ai-ctx-timeframe" dir="ltr">
            {snap.timeframe}
          </span>
        </Row>
        <Row part="price" label={t('ai.ctx.price')}>
          <div className="ai-ctx-price">
            <span
              key={lastPx}
              className={`tnum ai-last ${dir.current ? `is-${dir.current}` : ''}`}
              data-testid="ai-ctx-last"
              dir="ltr"
            >
              {fmt(lastPx !== undefined ? lastPx * tick : null)}
            </span>
            <span className="tnum ai-ctx-sub" dir="ltr">
              {t('ai.ctx.bidAsk', { bid: fmt(snap.bid), ask: fmt(snap.ask) })}
            </span>
          </div>
          <Spark values={spark} up={spark.length < 2 || spark[spark.length - 1]! >= spark[0]!} />
        </Row>
        <Row part="flow" label={t('ai.ctx.flow')}>
          <Footprint rows={fp} />
          {flow && (
            <div className="tnum ai-ctx-sub" dir="ltr">
              {t('ai.ctx.delta', { delta: flow.delta, poc: flow.poc ?? '—' })}
            </div>
          )}
        </Row>
        <Row part="positions" label={t('ai.ctx.positions')}>
          {snap.positions.length === 0 ? (
            <span className="ai-ctx-sub">{t('ai.ctx.flat')}</span>
          ) : (
            <ul className="ai-ctx-list tnum" dir="ltr">
              {snap.positions.map((p) => (
                <li key={p.instrument}>
                  <span>
                    {p.instrument.split(':').pop()} {p.qty > 0 ? '+' : ''}
                    {p.qty} @ {p.avgPrice}
                  </span>
                  <span className={(p.unrealized ?? 0) >= 0 ? 'is-up' : 'is-down'}>
                    {p.unrealized === null ? '—' : signed(p.unrealized)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="tnum ai-ctx-sub" dir="ltr">
            {t('ai.ctx.dayPnl')}{' '}
            <span className={dayPnl >= 0 ? 'is-up' : 'is-down'}>{signed(dayPnl)}</span>
            {' · '}
            {t('ai.ctx.workingOrders', { n: snap.workingOrders })}
          </div>
        </Row>
        <Row part="indicators" label={t('ai.ctx.indicators')}>
          {snap.indicators.length ? (
            <div className="ai-ctx-chips">
              {snap.indicators.map((n, i) => (
                <span key={`${n}${i}`} className="ai-chip-static">
                  {n}
                </span>
              ))}
            </div>
          ) : (
            <span className="ai-ctx-sub">{t('ai.ctx.noIndicators')}</span>
          )}
        </Row>
        <Row part="account" label={t('ai.ctx.account')}>
          {snap.account ? (
            <span className="tnum ai-ctx-val" dir="ltr">
              {snap.account.name} · {snap.account.balance.toFixed(2)} {snap.account.currency}
            </span>
          ) : (
            <span className="ai-ctx-sub">—</span>
          )}
        </Row>
      </div>
    </aside>
  );
}
