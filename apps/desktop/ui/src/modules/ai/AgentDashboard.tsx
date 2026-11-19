import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pause, Play, ShieldAlert } from 'lucide-react';
import { Badge, Button, Checkbox, Input, NumberInput, Select, Toggle } from '@htflow/ui-kit';
import { t, translateLiteral as tl } from '@htflow/i18n';
import { askConfirm } from '../../state/confirm';
import { paper } from '../../state/market';
import { OrderCard } from './Cards';
import { parseSymbols } from './guard';
import {
  agentDayPnl,
  agentDayPnlOfAccount,
  agentMaxPosition,
  agentStepInfo,
  ai,
  guard,
  killSwitch,
  setAgent,
  startAgent,
  stopAgent,
} from './runtime';

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export const countdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

/** Gauge level: ok under 60 %, warn under 90 %, then danger. */
export const gaugeLevel = (ratio: number): 'ok' | 'warn' | 'danger' =>
  ratio >= 0.9 ? 'danger' : ratio >= 0.6 ? 'warn' : 'ok';

function Gauge({
  label,
  value,
  max,
  text,
  testId,
}: {
  label: string;
  value: number;
  max: number;
  text: string;
  testId: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="ai-gauge" data-level={gaugeLevel(ratio)} data-testid={testId}>
      <div className="ai-gauge-top">
        <span>{label}</span>
        <span className="tnum" dir="ltr">
          {text}
        </span>
      </div>
      <div
        className="ai-gauge-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <span style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}

const signed = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(2)}`;

export function AgentTab() {
  useSyncExternalStore(ai.subscribe, ai.version);
  const st = ai.state();
  const a = st.agent;
  const l = a.limits;
  const now = useNow(1000);
  const [symbols, setSymbols] = useState(l.allowedSymbols.join(', '));
  const acc = paper.accounts.get(a.accountId);
  const live = acc ? acc.kind !== 'paper' : false;
  const setLimits = (p: Partial<typeof l>) => setAgent({ limits: { ...l, ...p } });

  const status: 'killed' | 'running' | 'paused' | 'idle' = guard.isKilled
    ? 'killed'
    : st.agentRunning
      ? 'running'
      : st.agentStarted
        ? 'paused'
        : 'idle';
  const steps = agentStepInfo();
  const agentPnl = agentDayPnl(now);
  const dayPnl = agentDayPnlOfAccount();
  const ordersHour = guard.ordersInLastHour(now);
  const maxPos = agentMaxPosition();
  const pending = Object.values(st.orders).filter((o) => o.status === 'pending');
  const timeline = [...st.audit].reverse().slice(0, 40);

  return (
    <div className="ai-agent col" data-testid="ai-agent" data-status={status}>
      <div className={`ai-agent-hero is-${status}`}>
        <div className="ai-agent-state">
          <span className="ai-status-dot" data-status={status} aria-hidden />
          <strong data-testid="ai-agent-status">
            {status === 'running'
              ? t('ai.agentRunning')
              : status === 'killed'
                ? t('ai.killOn')
                : status === 'paused'
                  ? t('ai.agentPaused')
                  : t('ai.agentIdle')}
          </strong>
          {guard.isLiveArmed && <Badge kind="delayed">{t('ai.liveArmed')}</Badge>}
          <Badge kind={live ? 'delayed' : 'default'}>{acc?.name ?? a.accountId}</Badge>
        </div>
        <div className="ai-agent-buttons">
          {st.agentRunning ? (
            <Button size="lg" onClick={stopAgent} data-testid="ai-agent-stop">
              <Pause size={14} aria-hidden /> {t('ai.pauseAgent')}
            </Button>
          ) : (
            <Button
              size="lg"
              variant="primary"
              onClick={() => startAgent()}
              data-testid="ai-agent-start"
            >
              <Play size={14} aria-hidden />{' '}
              {status === 'paused' ? t('ai.resumeAgent') : t('ai.startAgent')}
            </Button>
          )}
          <Button size="lg" variant="destructive" onClick={killSwitch} data-testid="ai-kill">
            <ShieldAlert size={14} aria-hidden /> {t('ai.killSwitch')}
          </Button>
          {guard.isKilled && (
            <Button variant="outline" onClick={() => guard.resetKill()} data-testid="ai-kill-reset">
              {t('ai.resetKill')}
            </Button>
          )}
        </div>
        <div className="ai-confirm-each" data-testid="ai-confirm-each">
          <Toggle
            checked={l.confirmEachTrade}
            label={t('ai.confirmEach')}
            onChange={(v) => setLimits({ confirmEachTrade: v })}
          />
          <span>
            {t('ai.confirmEach')}
            <span className="ai-hint">
              {' '}
              {l.confirmEachTrade ? t('ai.confirmEachOn') : t('ai.confirmEachOff')}
            </span>
          </span>
        </div>
      </div>

      <div className="ai-tiles">
        <div className="ai-tile">
          <span>{t('ai.nextRunLabel')}</span>
          <strong className="tnum" data-testid="ai-next-run" dir="ltr">
            {st.nextRunAt ? countdown(st.nextRunAt - now) : '—'}
          </strong>
          <small className="tnum">{t('ai.everyNSeconds', { n: a.intervalSec })}</small>
        </div>
        <div className="ai-tile">
          <span>{t('ai.stepsUsed')}</span>
          <strong className="tnum" data-testid="ai-steps" dir="ltr">
            {steps.used} / {steps.max}
          </strong>
          <small>{t('ai.stepsHint')}</small>
        </div>
        <div className="ai-tile">
          <span>{t('ai.agentPnl')}</span>
          <strong
            className={`tnum ${agentPnl >= 0 ? 'is-up' : 'is-down'}`}
            data-testid="ai-agent-pnl"
            dir="ltr"
          >
            {signed(agentPnl)}
          </strong>
          <small>{t('ai.agentPnlHint')}</small>
        </div>
        <div className="ai-tile">
          <span>{t('ai.accountDayPnl')}</span>
          <strong className={`tnum ${dayPnl >= 0 ? 'is-up' : 'is-down'}`} dir="ltr">
            {signed(dayPnl)}
          </strong>
          <small>{acc?.currency ?? ''}</small>
        </div>
      </div>

      <div className="ai-gauges" data-testid="ai-gauges">
        <Gauge
          testId="ai-gauge-orders"
          label={t('ai.maxOrders')}
          value={ordersHour}
          max={l.maxOrdersPerHour}
          text={`${ordersHour} / ${l.maxOrdersPerHour}`}
        />
        <Gauge
          testId="ai-gauge-loss"
          label={t('ai.dailyLoss')}
          value={Math.max(0, -dayPnl)}
          max={l.dailyLossStop}
          text={`${Math.max(0, -dayPnl).toFixed(0)} / ${l.dailyLossStop}`}
        />
        <Gauge
          testId="ai-gauge-qty"
          label={t('ai.maxQty')}
          value={maxPos}
          max={l.maxQty}
          text={`${maxPos} / ${l.maxQty}`}
        />
      </div>

      {pending.length > 0 && (
        <section data-testid="ai-approvals">
          <h4>{t('ai.approvals', { n: pending.length })}</h4>
          {pending.map((o) => (
            <OrderCard key={o.id} callId={o.id} args={o.args} />
          ))}
        </section>
      )}

      <section>
        <h4>{t('ai.timeline')}</h4>
        {timeline.length === 0 ? (
          <div className="ai-hint">{t('ai.timelineEmpty')}</div>
        ) : (
          <ol className="ai-timeline" data-testid="ai-timeline">
            {timeline.map((r) => (
              <li key={r.id} className={r.ok ? 'is-ok' : 'is-error'} data-testid="ai-timeline-item">
                <span className="ai-tl-dot" aria-hidden />
                <time className="tnum">{new Date(r.ts).toLocaleTimeString()}</time>
                <strong>{r.tool}</strong>
                <span className="ai-tl-mode">{r.mode}</span>
                <span className="ai-tl-sum">{r.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <details className="ai-config">
        <summary>{t('ai.configuration')}</summary>
        <div className="ai-form">
          <label>
            {t('ai.account')}
            <Select<string>
              aria-label={t('ai.agentAccount')}
              value={a.accountId}
              onChange={(v) => setAgent({ accountId: v })}
              options={[...paper.accounts.values()].map((x) => ({
                value: x.id,
                label: `${x.name} (${x.kind})`,
              }))}
            />
          </label>
          <label>
            {t('ai.scheduledProvider')}
            <span className="ai-hint">{t('ai.scheduledProviderHint')}</span>
          </label>
          <label>
            {t('ai.runEvery')}
            <NumberInput
              aria-label={t('ai.intervalSeconds')}
              value={a.intervalSec}
              min={30}
              max={86400}
              step={30}
              onChange={(v) => setAgent({ intervalSec: v })}
            />
          </label>
          <label>
            {t('ai.maxStepsLabel')}
            <NumberInput
              aria-label={t('ai.maxSteps')}
              value={a.maxSteps}
              min={1}
              max={20}
              onChange={(v) => setAgent({ maxSteps: v })}
            />
          </label>
          <label className="ai-wide">
            {t('ai.goal')}
            <textarea
              aria-label={t('ai.agentGoal')}
              value={a.goal}
              onChange={(e) => setAgent({ goal: e.target.value })}
            />
          </label>
        </div>
        <h4>{t('ai.hardLimits')}</h4>
        <div className="ai-form">
          <label>
            {t('ai.maxQtyLabel')}
            <NumberInput
              aria-label={t('ai.maxQty')}
              value={l.maxQty}
              min={0.000001}
              step={1}
              onChange={(v) => setLimits({ maxQty: v })}
            />
          </label>
          <label>
            {t('ai.maxOrders')}
            <NumberInput
              aria-label={t('ai.maxOrders')}
              value={l.maxOrdersPerHour}
              min={1}
              max={1000}
              onChange={(v) => setLimits({ maxOrdersPerHour: v })}
            />
          </label>
          <label>
            {t('ai.dailyLoss')}
            <NumberInput
              aria-label={t('ai.dailyLoss')}
              value={l.dailyLossStop}
              min={1}
              step={50}
              onChange={(v) => setLimits({ dailyLossStop: v })}
            />
          </label>
          <label>
            {t('ai.allowedSymbolsLabel')}
            <Input
              aria-label={t('ai.allowedSymbols')}
              value={symbols}
              placeholder={tl('BTCUSDT, ESZ6')}
              onChange={(e) => setSymbols(e.target.value)}
              onBlur={() => setLimits({ allowedSymbols: parseSymbols(symbols) })}
            />
          </label>
          <Checkbox
            checked={l.confirmEachTrade}
            onChange={(v) => setLimits({ confirmEachTrade: v })}
            label={t('ai.confirmEach')}
          />
        </div>
        <div className="ai-live">
          <Toggle
            checked={guard.isLiveArmed}
            label={t('ai.armLive')}
            onChange={async (on) => {
              if (!on) return guard.armLive(false);
              const ok = await askConfirm({
                title: t('ai.armTitle'),
                body: t('ai.armBody'),
                confirmLabel: t('ai.armConfirm'),
                danger: true,
              });
              if (ok) guard.armLive(true);
            }}
          />
          <span className="ai-hint">{live ? t('ai.liveSelected') : t('ai.paperNoArm')}</span>
        </div>
      </details>
    </div>
  );
}
