import { useEffect, useState } from 'react';
import { Button, Toggle, toast } from '@htflow/ui-kit';
import {
  alertStatus,
  newAlert,
  validateCondition,
  type Alert,
  type AlertActions,
  type AlertCondition,
  type AlertKind,
} from '@htflow/alerts';
import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import { formatPrice } from '@htflow/market-data';
import { registerChartExtension } from '../../charts/extensions';
import { allInstruments, DEFAULT_INSTRUMENT, instrumentById } from '../../state/instruments';
import { activeInstrument } from '../../state/windows';
import { isTauri } from '../../backend';
import { registerModule } from '../registry';
import { alerts, describe, ensureNotificationPermission } from './runtime';
import './styles.css';

const KINDS: { id: AlertKind; label: string }[] = [
  { id: 'price-cross', label: 'Price crosses value' },
  { id: 'big-trade', label: 'Big trade ≥ size' },
  { id: 'bar-delta', label: 'Bar delta ≥ / ≤ value' },
  { id: 'dom-size', label: 'DOM level size ≥ X within N ticks' },
  { id: 'connection-lost', label: 'Connection lost' },
];
const ACTIONS: { id: keyof AlertActions; label: string }[] = [
  { id: 'popup', label: 'Popup' },
  { id: 'sound', label: 'Sound' },
  { id: 'desktop', label: 'Windows toast' },
  { id: 'log', label: 'Log' },
];
const COOLDOWNS = [0, 10_000, 30_000, 60_000, 300_000];
const EXPIRY: { label: string; ms: number | null }[] = [
  { label: 'never', ms: null },
  { label: '1 hour', ms: 3_600_000 },
  { label: 'end of day', ms: -1 },
  { label: '1 week', ms: 7 * 86_400_000 },
];

function useAlerts(): Alert[] {
  const [, set] = useState(0);
  useEffect(() => {
    const u = alerts.onChange(() => set((x) => x + 1));
    const i = setInterval(() => set((x) => x + 1), 1000);
    return () => {
      u();
      clearInterval(i);
    };
  }, []);
  return alerts.list();
}

function statusText(a: Alert, now: number): string {
  const st = alertStatus(a, now);
  if (st === 'disabled') return 'disabled';
  if (st === 'expired') return 'expired';
  if (st === 'done') return `done · fired ${a.fired}×`;
  if (a.fired) return `fired ${a.fired}×${st === 'cooldown' ? ' · cooldown' : ''}`;
  return 'waiting';
}

function NewAlertForm() {
  const insts = allInstruments(isTauri);
  const [kind, setKind] = useState<AlertKind>('price-cross');
  const [inst, setInst] = useState(activeInstrument() ?? DEFAULT_INSTRUMENT);
  const [dir, setDir] = useState<'up' | 'down' | 'any'>('any');
  const [op, setOp] = useState<'gte' | 'lte'>('gte');
  const [side, setSide] = useState('any');
  const [value, setValue] = useState('');
  const [ticks, setTicks] = useState('5');
  const [barMin, setBarMin] = useState('1');
  const [anyConn, setAnyConn] = useState(true);
  const [actions, setActions] = useState<AlertActions>({
    popup: true,
    sound: true,
    desktop: false,
    log: true,
  });
  const [cooldown, setCooldown] = useState(30_000);
  const [expiry, setExpiry] = useState(0);
  const [maxTriggers, setMaxTriggers] = useState('0');
  const i = instrumentById(inst);
  const v = parseFloat(value);
  let cond: AlertCondition;
  switch (kind) {
    case 'price-cross':
      cond = {
        kind,
        instrumentId: inst,
        px: i && Number.isFinite(v) ? Math.round(v / i.tickSize) : NaN,
        direction: dir,
      };
      break;
    case 'big-trade':
      cond = { kind, instrumentId: inst, minQty: v, side: side as 'buy' | 'sell' | 'any' };
      break;
    case 'bar-delta':
      cond = { kind, instrumentId: inst, barMs: parseFloat(barMin) * 60_000, op, value: v };
      break;
    case 'dom-size':
      cond = {
        kind,
        instrumentId: inst,
        minQty: v,
        withinTicks: parseInt(ticks, 10),
        side: side === 'buy' ? 'bid' : side === 'sell' ? 'ask' : 'any',
      };
      break;
    default:
      cond = { kind: 'connection-lost', instrumentId: anyConn ? null : inst };
  }
  const errors = validateCondition(cond);
  const create = async () => {
    if (errors.length) return;
    if (actions.desktop && !(await ensureNotificationPermission()))
      toast('warning', 'Desktop notifications are blocked', 'The other actions still run.');
    const now = Date.now();
    const e = EXPIRY[expiry]!.ms;
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    alerts.add(
      newAlert(cond, {
        actions,
        cooldownMs: cooldown,
        maxTriggers: Math.max(0, parseInt(maxTriggers, 10) || 0),
        expiresAt: e === null ? null : e < 0 ? end.getTime() : now + e,
      }),
    );
    setValue('');
    toast('success', 'Alert created', describe(cond));
  };
  const needsValue = kind !== 'connection-lost';
  return (
    <div className="al-form" data-testid="alert-form">
      <b>New alert</b>
      <span className="muted">Condition type</span>
      <select
        className="ht-select ht-select--sm"
        aria-label="Condition type"
        value={kind}
        onChange={(e) => setKind(e.target.value as AlertKind)}
      >
        {KINDS.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
          </option>
        ))}
      </select>
      {kind === 'connection-lost' ? (
        <label className="ht-check">
          <input type="checkbox" checked={anyConn} onChange={(e) => setAnyConn(e.target.checked)} />
          Any connection
        </label>
      ) : null}
      {(kind !== 'connection-lost' || !anyConn) && (
        <select
          className="ht-select ht-select--sm"
          aria-label="Instrument"
          value={inst}
          onChange={(e) => setInst(e.target.value)}
        >
          {insts.map((x) => (
            <option key={x.id} value={x.id}>
              {x.symbol} · {x.exchange}
            </option>
          ))}
        </select>
      )}
      {needsValue && (
        <div className="row gap6">
          {kind === 'price-cross' && (
            <select
              className="ht-select ht-select--sm"
              aria-label="Direction"
              value={dir}
              onChange={(e) => setDir(e.target.value as 'up' | 'down' | 'any')}
            >
              <option value="any">crosses</option>
              <option value="up">crosses above</option>
              <option value="down">crosses below</option>
            </select>
          )}
          {kind === 'bar-delta' && (
            <>
              <select
                className="ht-select ht-select--sm"
                aria-label="Bar"
                value={barMin}
                onChange={(e) => setBarMin(e.target.value)}
              >
                {['1', '5', '15', '60'].map((m) => (
                  <option key={m} value={m}>
                    {m}m bar
                  </option>
                ))}
              </select>
              <select
                className="ht-select ht-select--sm"
                aria-label="Operator"
                value={op}
                onChange={(e) => setOp(e.target.value as 'gte' | 'lte')}
              >
                <option value="gte">≥</option>
                <option value="lte">≤</option>
              </select>
            </>
          )}
          {(kind === 'big-trade' || kind === 'dom-size') && (
            <select
              className="ht-select ht-select--sm"
              aria-label="Side"
              value={side}
              onChange={(e) => setSide(e.target.value)}
            >
              <option value="any">any side</option>
              <option value="buy">{kind === 'dom-size' ? 'bid' : 'buy'}</option>
              <option value="sell">{kind === 'dom-size' ? 'ask' : 'sell'}</option>
            </select>
          )}
          <input
            className="ht-input al-in grow tnum"
            aria-label="Value"
            data-testid="alert-value"
            placeholder={kind === 'price-cross' ? 'price' : kind === 'bar-delta' ? 'delta' : 'size'}
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {kind === 'dom-size' && (
            <input
              className="ht-input al-in tnum"
              aria-label="Within ticks"
              title="Within N ticks of the best price"
              style={{ width: 56 }}
              value={ticks}
              onChange={(e) => setTicks(e.target.value)}
            />
          )}
        </div>
      )}
      <span className="muted">Actions</span>
      <div className="row gap6 wrap">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className="ht-chip"
            aria-pressed={actions[a.id]}
            onClick={() => setActions({ ...actions, [a.id]: !actions[a.id] })}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="row gap6">
        <select
          className="ht-select ht-select--sm grow"
          aria-label="Cooldown"
          value={cooldown}
          onChange={(e) => setCooldown(Number(e.target.value))}
        >
          {COOLDOWNS.map((c) => (
            <option key={c} value={c}>
              Cooldown {c === 0 ? 'none' : c < 60_000 ? `${c / 1000} s` : `${c / 60_000} min`}
            </option>
          ))}
        </select>
        <select
          className="ht-select ht-select--sm grow"
          aria-label="Expiry"
          value={expiry}
          onChange={(e) => setExpiry(Number(e.target.value))}
        >
          {EXPIRY.map((x, k) => (
            <option key={x.label} value={k}>
              Expires: {x.label}
            </option>
          ))}
        </select>
      </div>
      <label className="row gap6 center-y muted">
        Trigger count (0 = unlimited)
        <input
          className="ht-input al-in tnum"
          aria-label="Trigger count"
          style={{ width: 56 }}
          value={maxTriggers}
          onChange={(e) => setMaxTriggers(e.target.value)}
        />
      </label>
      {errors.length > 0 && value !== '' && <span className="down">{errors.join(' · ')}</span>}
      <span className="grow" />
      <Button
        variant="primary"
        block
        disabled={errors.length > 0}
        onClick={() => void create()}
        data-testid="alert-create"
      >
        Create alert
      </Button>
    </div>
  );
}

function AlertsWindow() {
  const list = useAlerts();
  const now = Date.now();
  const active = list.filter((a) => alertStatus(a, now) === 'waiting').length;
  return (
    <div className="module-window al" data-testid="alerts-window">
      <div className="al-head">
        <b>Alerts</b>
        <span className="muted">· {active} active</span>
      </div>
      <div className="al-body">
        <div className="al-list">
          {list.map((a) => (
            <div key={a.id} className="al-row" data-testid="alert-row">
              <Toggle
                checked={a.enabled}
                label={`Enable ${describe(a.condition)}`}
                onChange={(v) => alerts.update(a.id, { enabled: v })}
              />
              <div className="grow">
                <div className="al-desc">{describe(a.condition)}</div>
                <div className="muted al-sub">
                  {ACTIONS.filter((x) => a.actions[x.id])
                    .map((x) => x.label)
                    .join(' · ') || 'no actions'}
                  {a.cooldownMs ? ` · cooldown ${a.cooldownMs / 1000} s` : ''}
                  {a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleString()}` : ''}
                </div>
              </div>
              <span className="muted al-status">{statusText(a, now)}</span>
              <button
                className="al-x"
                aria-label="Delete alert"
                onClick={() => alerts.remove(a.id)}
              >
                ✕
              </button>
            </div>
          ))}
          {!list.length && (
            <div className="tbl-empty">
              No alerts yet. Create one here or right-click a chart → “Set alert at …”.
            </div>
          )}
        </div>
        <NewAlertForm />
      </div>
    </div>
  );
}

registerModule({ id: 'alerts', view: AlertsWindow });

/* ---------------- chart integration ---------------- */

/** Dashed lines at price-cross alert levels. */
class AlertLinesLayer implements ChartLayer {
  readonly id = 'alert-lines';
  constructor(private instrumentId: () => string) {}
  draw(v: ChartView): void {
    const id = this.instrumentId();
    const { ctx } = v;
    const now = Date.now();
    for (const a of alerts.list()) {
      const c = a.condition;
      if (c.kind !== 'price-cross' || c.instrumentId !== id) continue;
      const st = alertStatus(a, now);
      if (st === 'disabled' || st === 'expired' || st === 'done') continue;
      if (c.px < v.priceMin || c.px > v.priceMax) continue;
      const y = Math.round(v.yOf(c.px)) + 0.5;
      ctx.save();
      ctx.strokeStyle = v.palette.warning;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(v.plot.x, y);
      ctx.lineTo(v.plot.x + v.plot.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = v.palette.warning;
      ctx.font = v.font(10, 600);
      ctx.textBaseline = 'bottom';
      ctx.fillText('🔔 alert', v.plot.x + 6, y - 2);
      ctx.restore();
      v.tags.push({ px: c.px, bg: v.palette.warning, fg: '#000' });
    }
  }
}

registerChartExtension({
  id: 'alerts',
  layers: (ctx) => [new AlertLinesLayer(() => ctx.store.instrument.id)],
  attach: (ctx) => alerts.onChange(() => ctx.cores.forEach((c) => c.invalidate())),
  menu: (ctx, px) => {
    if (px === null) return [];
    const inst = ctx.store.instrument;
    const label = formatPrice(px, inst);
    return [
      { kind: 'separator', id: 'alerts-sep' },
      {
        id: 'alerts-set',
        label: `Set alert at ${label}`,
        onSelect: () => {
          alerts.add(
            newAlert({ kind: 'price-cross', instrumentId: inst.id, px, direction: 'any' }),
          );
          toast('success', 'Alert created', `${inst.symbol} price crosses ${label}`);
        },
      },
    ];
  },
});
