import { useEffect, useState } from 'react';
import { risk, riskStore } from '../../modules/risk/engine';
import { domActions } from './actions';

const money = (v: number) =>
  (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

/** Prop DOM: the account's risk limits next to the ladder (read-only view of the risk engine). */
export function RiskStrip({ instrumentId }: { instrumentId: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000);
    const u = riskStore.subscribe(() => tick((x) => x + 1));
    return () => {
      clearInterval(i);
      u();
    };
  }, []);
  const acc = domActions.account(instrumentId);
  const st = risk.status(acc);
  const r = risk.rules(acc);
  const pos = Math.abs(domActions.position(instrumentId).qty);
  const maxPos = r.maxPositionSize.perInstrument[instrumentId] ?? r.maxPositionSize.value;
  const cls = (used: number) => (used >= 1 ? 'bad' : used >= 0.8 ? 'warn' : '');
  return (
    <div className="sdom-risk" data-testid="dom-risk" title="Risk limits (Risk window)">
      <span className={cls(st.dailyLossUsed)}>
        Day {money(st.dayPnl)}
        {r.dailyLossLimit.enabled && <em> / −{money(r.dailyLossLimit.value).slice(1)}</em>}
      </span>
      <span className={r.maxPositionSize.enabled ? cls(pos / Math.max(1, maxPos)) : ''}>
        Pos {pos}
        {r.maxPositionSize.enabled && <em> / {maxPos}</em>}
      </span>
      <span
        className={r.maxTradesPerDay.enabled ? cls(st.tradesToday / r.maxTradesPerDay.value) : ''}
      >
        Trades {st.tradesToday}
        {r.maxTradesPerDay.enabled && <em> / {r.maxTradesPerDay.value}</em>}
      </span>
      {st.locked && <span className="bad">Locked</span>}
    </div>
  );
}
