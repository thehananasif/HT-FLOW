import { useEffect, useState } from 'react';
import { Button, Toggle, toast } from '@htflow/ui-kit';
import {
  alertStatus,
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
import { getSetting, setSetting, useSetting } from '../../state/settings';
import { BUILTIN_SOUNDS, MAX_CUSTOM_SOUNDS, MAX_CUSTOM_SOUND_BYTES } from '../../sound';
import { isTauri } from '../../backend';
import { registerCommands } from '../../shell/commands';
import { registerModule } from '../registry';
import { alerts, describe, ensureNotificationPermission, playAlertSound } from './runtime';
import { addAlert, alertDefaults, removeAlert, setAllEnabled, testAlert } from './api';
import {
  deliver,
  loadDelivery,
  saveDelivery,
  validateDelivery,
  type Channel,
  type DeliveryConfig,
} from './delivery';
import './styles.css';

/** Kinds the form can create (drawing alerts come from charts, indicator alerts from Indicators). */
const KINDS: { id: AlertKind; label: string }[] = [
  { id: 'price-cross', label: 'Price crosses value' },
  { id: 'big-trade', label: 'Big trade ≥ size' },
  { id: 'bar-delta', label: 'Bar delta ≥ / ≤ value' },
  { id: 'dom-size', label: 'DOM level size ≥ X within N ticks' },
  { id: 'funding', label: 'Funding rate (perpetuals)' },
  { id: 'liquidation', label: 'Liquidations ≥ size' },
  { id: 'connection-lost', label: 'Connection lost' },
];
type Flag = 'popup' | 'sound' | 'desktop' | 'log' | 'flash' | 'telegram' | 'discord';
const ACTIONS: { id: Flag; label: string }[] = [
  { id: 'popup', label: 'Popup' },
  { id: 'sound', label: 'Sound' },
  { id: 'desktop', label: 'Windows toast' },
  { id: 'flash', label: 'Flash window' },
  { id: 'log', label: 'Log' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'discord', label: 'Discord' },
];
const COOLDOWNS = [0, 10_000, 30_000, 60_000, 300_000];
const EXPIRY: { label: string; ms: number | null }[] = [
  { label: 'never', ms: null },
  { label: '1 hour', ms: 3_600_000 },
  { label: 'end of day', ms: -1 },
  { label: '1 week', ms: 7 * 86_400_000 },
];
const LIQ_WINDOWS = [
  { ms: 0, label: 'single print' },
  { ms: 60_000, label: 'in 1 min' },
  { ms: 300_000, label: 'in 5 min' },
  { ms: 900_000, label: 'in 15 min' },
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

const readAsDataUrl = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('Could not read the file'));
    r.readAsDataURL(f);
  });

/** Adds a local .wav / .mp3 / .ogg to the profile's sound list; returns its sound ref. */
export async function addSoundFile(f: File): Promise<string | null> {
  if (!/^audio\//.test(f.type) && !/\.(wav|mp3|ogg|m4a)$/i.test(f.name)) {
    toast('error', 'Not an audio file', f.name);
    return null;
  }
  if (f.size > MAX_CUSTOM_SOUND_BYTES) {
    toast('error', 'Sound file too large', 'Max 2 MB per file.');
    return null;
  }
  const list = getSetting('sounds.custom');
  if (list.length >= MAX_CUSTOM_SOUNDS) {
    toast('error', 'Too many sound files', `Max ${MAX_CUSTOM_SOUNDS}.`);
    return null;
  }
  let dataUrl = await readAsDataUrl(f);
  // Some systems report no MIME type: label it as audio so the validator accepts it.
  dataUrl = dataUrl.replace(/^data:[^;]*;base64,/, (m) =>
    m.startsWith('data:audio/') ? m : 'data:audio/mpeg;base64,',
  );
  const id = `s${Date.now().toString(36)}`;
  const err = setSetting('sounds.custom', [...list, { id, name: f.name.slice(0, 120), dataUrl }]);
  if (err) {
    toast('error', 'Could not add the sound', err);
    return null;
  }
  toast('success', 'Sound added', `${f.name} is saved in your profile.`);
  return `custom:${id}`;
}

function SoundPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const custom = useSetting('sounds.custom');
  return (
    <div className="row gap6">
      <select
        className="ht-select ht-select--sm grow"
        aria-label="Alert sound"
        data-testid="alert-sound"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Default (Settings → Sounds → Alert)</option>
        {BUILTIN_SOUNDS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
        {custom.map((s) => (
          <option key={s.id} value={`custom:${s.id}`}>
            {s.name}
          </option>
        ))}
      </select>
      <label className="ht-btn ht-btn--outline ht-btn--xs al-file" title="Add your own sound file">
        File…
        <input
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.m4a"
          data-testid="alert-sound-file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void addSoundFile(f).then((ref) => ref && onChange(ref));
          }}
        />
      </label>
      <button className="al-x" aria-label="Preview sound" onClick={() => playAlertSound(value)}>
        ▶
      </button>
    </div>
  );
}

function DeliveryPanel() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<DeliveryConfig>({
    telegramToken: '',
    telegramChat: '',
    discordWebhook: '',
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) void loadDelivery().then(setCfg);
  }, [open]);
  const errors = validateDelivery(cfg);
  const set = (p: Partial<DeliveryConfig>) => setCfg({ ...cfg, ...p });
  const test = async () => {
    setBusy(true);
    try {
      await saveDelivery(cfg);
      const ch: Channel[] = [];
      if (cfg.telegramToken) ch.push('telegram');
      if (cfg.discordWebhook) ch.push('discord');
      if (!ch.length) {
        toast('info', 'Nothing to test', 'Enter a Telegram bot or a Discord webhook first.');
        return;
      }
      const errs = await deliver(ch, '🔔 HT Flow test message', { ignoreThrottle: true });
      if (errs.length) toast('error', 'Test failed', errs.join(' · '), 8000);
      else toast('success', 'Test sent', ch.join(' + '));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="al-delivery" data-testid="alert-delivery">
      <button className="al-section" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Delivery: Telegram / Discord
      </button>
      {open && (
        <>
          <span className="muted al-sub">
            Free: use your own Telegram bot (@BotFather) or a Discord channel webhook. Stored
            encrypted in your profile vault.
          </span>
          <input
            className="ht-input al-in"
            type="password"
            autoComplete="off"
            aria-label="Telegram bot token"
            placeholder="Telegram bot token"
            value={cfg.telegramToken}
            onChange={(e) => set({ telegramToken: e.target.value })}
          />
          <input
            className="ht-input al-in"
            aria-label="Telegram chat id"
            placeholder="Telegram chat id (e.g. 123456789 or @channel)"
            value={cfg.telegramChat}
            onChange={(e) => set({ telegramChat: e.target.value })}
          />
          <input
            className="ht-input al-in"
            type="password"
            autoComplete="off"
            aria-label="Discord webhook URL"
            placeholder="Discord webhook URL"
            value={cfg.discordWebhook}
            onChange={(e) => set({ discordWebhook: e.target.value })}
          />
          {isTauri && cfg.discordWebhook && (
            <span className="muted al-sub">
              Discord from the desktop app needs a native POST command that is not shipped yet.
            </span>
          )}
          {errors.length > 0 && <span className="down">{errors.join(' · ')}</span>}
          <div className="row gap6">
            <Button
              size="sm"
              variant="primary"
              disabled={errors.length > 0 || busy}
              data-testid="delivery-save"
              onClick={() =>
                void saveDelivery(cfg).then(() => toast('success', 'Delivery settings saved'))
              }
            >
              Save
            </Button>
            <Button size="sm" disabled={errors.length > 0 || busy} onClick={() => void test()}>
              Send test
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function NewAlertForm() {
  const insts = allInstruments(isTauri);
  const [kind, setKind] = useState<AlertKind>('price-cross');
  const [inst, setInst] = useState(activeInstrument() ?? DEFAULT_INSTRUMENT);
  const [dir, setDir] = useState<'up' | 'down' | 'any'>('any');
  const [op, setOp] = useState<'gte' | 'lte'>('gte');
  const [fop, setFop] = useState<'gte' | 'lte' | 'abs-gte'>('abs-gte');
  const [side, setSide] = useState('any');
  const [value, setValue] = useState('');
  const [ticks, setTicks] = useState('5');
  const [barMin, setBarMin] = useState('1');
  const [liqWin, setLiqWin] = useState(0);
  const [anyConn, setAnyConn] = useState(true);
  const [actions, setActions] = useState<AlertActions>({
    popup: true,
    sound: true,
    desktop: false,
    log: true,
    flash: false,
    telegram: false,
    discord: false,
  });
  const [soundRef, setSoundRef] = useState('');
  const [cooldown, setCooldown] = useState(() => {
    const c = alertDefaults().cooldownMs;
    return COOLDOWNS.includes(c) ? c : 30_000;
  });
  const [expiry, setExpiry] = useState(0);
  const [maxTriggers, setMaxTriggers] = useState(() => String(alertDefaults().maxTriggers));
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
    case 'funding':
      cond = { kind, instrumentId: inst, op: fop, value: v };
      break;
    case 'liquidation':
      cond = {
        kind,
        instrumentId: inst,
        minQty: v,
        windowMs: liqWin,
        side: side === 'buy' ? 'sell' : side === 'sell' ? 'buy' : 'any',
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
    const r = addAlert(cond, {
      actions: { ...actions, ...(soundRef ? { soundRef } : {}) },
      cooldownMs: cooldown,
      maxTriggers: Math.max(0, parseInt(maxTriggers, 10) || 0),
      expiresAt: e === null ? null : e < 0 ? end.getTime() : now + e,
    });
    if (!r.ok) {
      toast('error', 'Alert not created', r.errors.join(' · '));
      return;
    }
    setValue('');
    toast('success', 'Alert created', describe(cond));
  };
  const needsValue = kind !== 'connection-lost';
  const liveOnly = kind === 'funding' || kind === 'liquidation';
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
      {liveOnly && (
        <span className="muted al-sub">
          Needs a live derivatives connection (Binance / Bybit futures …); the simulator has no{' '}
          {kind === 'funding' ? 'funding' : 'liquidations'}.
        </span>
      )}
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
          {kind === 'funding' && (
            <select
              className="ht-select ht-select--sm"
              aria-label="Funding operator"
              value={fop}
              onChange={(e) => setFop(e.target.value as 'gte' | 'lte' | 'abs-gte')}
            >
              <option value="abs-gte">|rate| ≥</option>
              <option value="gte">rate ≥</option>
              <option value="lte">rate ≤</option>
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
          {(kind === 'big-trade' || kind === 'dom-size' || kind === 'liquidation') && (
            <select
              className="ht-select ht-select--sm"
              aria-label="Side"
              value={side}
              onChange={(e) => setSide(e.target.value)}
            >
              <option value="any">any side</option>
              <option value="buy">
                {kind === 'dom-size' ? 'bid' : kind === 'liquidation' ? 'longs' : 'buy'}
              </option>
              <option value="sell">
                {kind === 'dom-size' ? 'ask' : kind === 'liquidation' ? 'shorts' : 'sell'}
              </option>
            </select>
          )}
          <input
            className="ht-input al-in grow tnum"
            aria-label="Value"
            data-testid="alert-value"
            placeholder={
              kind === 'price-cross'
                ? 'price'
                : kind === 'bar-delta'
                  ? 'delta'
                  : kind === 'funding'
                    ? '% e.g. 0.05'
                    : 'size'
            }
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
      {kind === 'liquidation' && (
        <select
          className="ht-select ht-select--sm"
          aria-label="Liquidation window"
          value={liqWin}
          onChange={(e) => setLiqWin(Number(e.target.value))}
        >
          {LIQ_WINDOWS.map((w) => (
            <option key={w.ms} value={w.ms}>
              Size: {w.label}
            </option>
          ))}
        </select>
      )}
      <span className="muted">Actions</span>
      <div className="row gap6 wrap">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className="ht-chip"
            data-testid={`alert-action-${a.id}`}
            aria-pressed={!!actions[a.id]}
            onClick={() => setActions({ ...actions, [a.id]: !actions[a.id] })}
          >
            {a.label}
          </button>
        ))}
      </div>
      {actions.sound && <SoundPicker value={soundRef} onChange={setSoundRef} />}
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
      <Button
        variant="primary"
        block
        disabled={errors.length > 0}
        onClick={() => void create()}
        data-testid="alert-create"
      >
        Create alert
      </Button>
      <DeliveryPanel />
    </div>
  );
}

function AlertsWindow() {
  const list = useAlerts();
  const enabled = useSetting('alerts.enabled');
  const now = Date.now();
  const active = list.filter((a) => alertStatus(a, now) === 'waiting').length;
  return (
    <div className="module-window al" data-testid="alerts-window">
      <div className="al-head">
        <b>Alerts</b>
        <span className="muted">· {active} active</span>
        {!enabled && (
          <span className="down" data-testid="alerts-paused">
            · paused (Settings → Alerts)
          </span>
        )}
      </div>
      <div className="al-body">
        <div className="al-list">
          {list.map((a) => (
            <div key={a.id} className="al-row" data-testid="alert-row" data-kind={a.condition.kind}>
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
                aria-label="Test alert"
                title="Run this alert's actions now"
                onClick={() => testAlert(a.id)}
              >
                ▶
              </button>
              <button className="al-x" aria-label="Delete alert" onClick={() => removeAlert(a.id)}>
                ✕
              </button>
            </div>
          ))}
          {!list.length && (
            <div className="tbl-empty">
              No alerts yet. Create one here, right-click a chart → “Set alert at …”, or turn on
              “Alert on cross” for a drawing.
            </div>
          )}
        </div>
        <NewAlertForm />
      </div>
    </div>
  );
}

registerModule({ id: 'alerts', view: AlertsWindow });

const openAlerts = () =>
  window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'alerts' }));

registerCommands([
  { id: 'alerts.open', label: 'Alerts: Open window', group: 'Platform', run: openAlerts },
  {
    id: 'alerts.pause',
    label: 'Alerts: Pause / resume all alerts',
    group: 'Platform',
    keywords: 'mute stop alerts master switch',
    run: () => {
      const on = !getSetting('alerts.enabled');
      setSetting('alerts.enabled', on);
      toast('info', on ? 'Alerts resumed' : 'Alerts paused');
    },
  },
  {
    id: 'alerts.enable-all',
    label: 'Alerts: Enable all',
    group: 'Platform',
    run: () => setAllEnabled(true),
  },
  {
    id: 'alerts.disable-all',
    label: 'Alerts: Disable all',
    group: 'Platform',
    run: () => setAllEnabled(false),
  },
  {
    id: 'alerts.test-delivery',
    label: 'Alerts: Send a test to Telegram / Discord',
    group: 'Platform',
    keywords: 'telegram discord webhook bot',
    run: () =>
      void loadDelivery().then(async (c) => {
        const ch: Channel[] = [];
        if (c.telegramToken) ch.push('telegram');
        if (c.discordWebhook) ch.push('discord');
        if (!ch.length) return toast('info', 'Set up delivery in the Alerts window first');
        const errs = await deliver(ch, '🔔 HT Flow test message', { ignoreThrottle: true });
        if (errs.length) toast('error', 'Test failed', errs.join(' · '), 8000);
        else toast('success', 'Test sent', ch.join(' + '));
      }),
  },
]);

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
          const r = addAlert(
            { kind: 'price-cross', instrumentId: inst.id, px, direction: 'any' },
            // Chart alerts keep the classic behaviour: repeat with a 30 s cool-down.
            { maxTriggers: 0, cooldownMs: 30_000 },
          );
          if (r.ok) toast('success', 'Alert created', `${inst.symbol} price crosses ${label}`);
          else toast('error', 'Alert not created', r.errors.join(' · '));
        },
      },
    ];
  },
});
