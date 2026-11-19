import { useState, useSyncExternalStore } from 'react';
import { Bell, Check, ChevronRight, Loader2, Minus, X } from 'lucide-react';
import { Badge, Button, NumberInput, toast } from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
import type { ToolCallRec, ToolResultRec } from './chat';
import { hasLevelLine, setAlertAtLevel, toggleLevelLine } from './chartActions';
import {
  cardMath,
  proposalFromArgs,
  proposalToArgs,
  type CardIssue,
  type Proposal,
} from './orderCard';
import { ai, decideOrder, orderContext, orderPreCheck } from './runtime';

/* ------------------------------------------------------------------ price chip */

/** A price the model mentioned: click draws / removes a line on the chart, the bell sets an alert. */
export function LevelChip({ value, text }: { value: number; text: string }) {
  const [drawn, setDrawn] = useState(() => hasLevelLine(value));
  const line = () => {
    const r = toggleLevelLine(value, t('ai.lineLabel', { price: text.replace(/^\$/, '') }));
    if (r === 'nochart') toast('info', t('ai.noChart'), t('ai.noChartBody'));
    else {
      setDrawn(r === 'added');
      toast('success', r === 'added' ? t('ai.lineDrawn') : t('ai.lineRemoved'), text);
    }
  };
  const alert = () => {
    const r = setAlertAtLevel(value);
    if (!r.ok) toast('error', t('ai.alertFailed'), r.error);
  };
  return (
    <span className={`ai-level${drawn ? ' is-drawn' : ''}`} dir="ltr" data-testid="ai-level">
      <button
        type="button"
        className="ai-level-main tnum"
        onClick={line}
        title={drawn ? t('ai.removeLine') : t('ai.drawLine')}
        aria-label={`${drawn ? t('ai.removeLine') : t('ai.drawLine')} ${text}`}
        aria-pressed={drawn}
        data-testid="ai-level-chip"
      >
        <Minus size={11} aria-hidden />
        {text}
      </button>
      <button
        type="button"
        className="ai-level-alert"
        onClick={alert}
        title={t('ai.setAlertHere')}
        aria-label={`${t('ai.setAlertHere')} ${text}`}
        data-testid="ai-level-alert"
      >
        <Bell size={11} aria-hidden />
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ tool step */

type StepState = 'running' | 'ok' | 'error';

const pretty = (s: string, max = 4000) => {
  let out = s;
  try {
    out = JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    /* not JSON: show as is */
  }
  return out.length > max ? `${out.slice(0, max)}\n…` : out;
};

/** A tool call as a collapsible step: name, status, arguments and the result the model got. */
export function StepCard({
  call,
  result,
  running,
}: {
  call: ToolCallRec;
  result?: ToolResultRec;
  running: boolean;
}) {
  const state: StepState = result
    ? result.isError
      ? 'error'
      : 'ok'
    : running
      ? 'running'
      : 'error';
  const label =
    state === 'running'
      ? t('ai.step.running')
      : state === 'ok'
        ? t('ai.step.ok')
        : t('ai.step.error');
  return (
    <details className={`ai-step is-${state}`} data-testid="ai-step" data-state={state}>
      <summary>
        <ChevronRight size={12} className="ai-step-chev" aria-hidden />
        {state === 'running' ? (
          <Loader2 size={12} className="ai-spin" aria-hidden />
        ) : state === 'ok' ? (
          <Check size={12} aria-hidden />
        ) : (
          <X size={12} aria-hidden />
        )}
        <span className="ai-step-name tnum">{call.name}</span>
        <span className="ai-step-status">{label}</span>
      </summary>
      <div className="ai-step-body">
        <div className="ai-step-label">{t('ai.step.args')}</div>
        <pre>{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
        {result && (
          <>
            <div className="ai-step-label">{t('ai.step.result')}</div>
            <pre>{pretty(result.content)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ order card */

const ISSUE_KEY: Record<CardIssue, Parameters<typeof t>[0]> = {
  noEntry: 'ai.order.issue.noEntry',
  noQty: 'ai.order.issue.noQty',
  noStop: 'ai.order.issue.noStop',
  stopSide: 'ai.order.issue.stopSide',
  targetSide: 'ai.order.issue.targetSide',
};

const money = (v: number | null, cur: string) =>
  v === null
    ? '—'
    : `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${cur}`;

/**
 * Rich card for a `place_order` tool call: side, size, entry, stop / target, money at risk and the
 * R-multiple. Confirm sends the order through the normal tool path (agent limits and the risk
 * engine still apply); Edit changes size and levels first; Reject declines it.
 */
export function OrderCard({
  callId,
  args,
  result,
}: {
  callId: string;
  args: unknown;
  result?: ToolResultRec;
}) {
  useSyncExternalStore(ai.subscribe, ai.version);
  const rec = ai.state().orders[callId];
  const shownArgs = (rec?.args ?? (args && typeof args === 'object' ? args : {})) as Record<
    string,
    unknown
  >;
  const ctx = orderContext(shownArgs);
  const econ = { tickSize: ctx.tickSize, tickValue: ctx.tickValue };
  const base = proposalFromArgs(shownArgs, { tickSize: ctx.tickSize, last: ctx.last });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Proposal | null>(null);
  if (!base) return null;
  const p = editing && draft ? draft : base;
  const math = cardMath(p, econ);
  const pending = rec?.status === 'pending';
  const status: 'pending' | 'rejected' | 'placed' | 'failed' | 'auto' | 'sent' = result
    ? result.isError
      ? rec?.status === 'rejected' || /declined/.test(result.content)
        ? 'rejected'
        : 'failed'
      : 'placed'
    : pending
      ? 'pending'
      : rec?.status === 'rejected'
        ? 'rejected'
        : rec?.status === 'auto'
          ? 'auto'
          : 'sent';
  const warn = pending ? orderPreCheck(shownArgs) : null;
  const dp = Math.min(8, Math.max(0, ctx.precision));
  const step = ctx.tickSize > 0 ? ctx.tickSize : 1;
  const edit = (patch: Partial<Proposal>) => setDraft({ ...(draft ?? base), ...patch });
  const px = (v: number | null) => (v === null ? '—' : v.toFixed(dp));
  const resultText = result ? pretty(result.content, 400) : '';

  const confirm = () => {
    const out = editing && draft ? proposalToArgs(shownArgs, draft, ctx.tickSize) : undefined;
    decideOrder(callId, 'confirm', out);
  };

  return (
    <div
      className={`ai-order is-${status} is-${p.side}`}
      data-testid="ai-order-card"
      data-status={status}
      data-call={callId}
    >
      <div className="ai-order-head">
        <span className={`ai-side ai-side--${p.side}`}>
          {p.side === 'buy' ? t('ai.order.buy') : t('ai.order.sell')}
        </span>
        <strong className="tnum" dir="ltr">
          {p.qty} {ctx.symbol}
        </strong>
        <span className="ai-order-type">
          {t(`ai.order.type.${p.type}` as 'ai.order.type.market')}
        </span>
        <span className="grow" />
        <Badge kind={ctx.accountKind === 'paper' ? 'default' : 'delayed'}>
          {ctx.accountKind === 'paper' ? t('ai.order.paper') : t('ai.order.live')}
        </Badge>
      </div>

      {editing ? (
        <div className="ai-order-edit">
          <label>
            {t('ai.order.qty')}
            <NumberInput
              aria-label={t('ai.order.qty')}
              value={p.qty}
              min={0}
              step={1}
              precision={4}
              onChange={(v) => edit({ qty: v })}
            />
          </label>
          {p.type !== 'market' && (
            <label>
              {t('ai.order.entry')}
              <NumberInput
                aria-label={t('ai.order.entry')}
                value={p.entry ?? ctx.last ?? 0}
                step={step}
                precision={dp}
                onChange={(v) => edit({ entry: v })}
              />
            </label>
          )}
          <label>
            {t('ai.order.stop')}
            <NumberInput
              aria-label={t('ai.order.stop')}
              value={p.stopLoss ?? p.entry ?? 0}
              step={step}
              precision={dp}
              onChange={(v) => edit({ stopLoss: v })}
            />
          </label>
          <label>
            {t('ai.order.target')}
            <NumberInput
              aria-label={t('ai.order.target')}
              value={p.takeProfit ?? p.entry ?? 0}
              step={step}
              precision={dp}
              onChange={(v) => edit({ takeProfit: v })}
            />
          </label>
        </div>
      ) : (
        <dl className="ai-order-grid tnum" dir="ltr">
          <div>
            <dt>{t('ai.order.entry')}</dt>
            <dd>{p.type === 'market' ? `${t('ai.order.market')} ~${px(p.entry)}` : px(p.entry)}</dd>
          </div>
          <div>
            <dt>{t('ai.order.stop')}</dt>
            <dd className="is-down">{px(p.stopLoss)}</dd>
          </div>
          <div>
            <dt>{t('ai.order.target')}</dt>
            <dd className="is-up">{px(p.takeProfit)}</dd>
          </div>
        </dl>
      )}

      <dl className="ai-order-risk tnum" dir="ltr">
        <div>
          <dt>{t('ai.order.risk')}</dt>
          <dd className="is-down" data-testid="ai-order-risk">
            {money(math.risk, ctx.currency)}
          </dd>
        </div>
        <div>
          <dt>{t('ai.order.reward')}</dt>
          <dd className="is-up">{money(math.reward, ctx.currency)}</dd>
        </div>
        <div>
          <dt>{t('ai.order.r')}</dt>
          <dd data-testid="ai-order-r">{math.r === null ? '—' : `${math.r}R`}</dd>
        </div>
      </dl>

      {math.issues.length > 0 && (
        <ul className="ai-order-issues" role="alert">
          {math.issues.map((i) => (
            <li key={i}>{t(ISSUE_KEY[i])}</li>
          ))}
        </ul>
      )}
      {warn && (
        <div className="ai-order-warn" role="alert" data-testid="ai-order-warn">
          {t('ai.order.guard', { reason: warn })}
        </div>
      )}

      {pending ? (
        <div className="ai-order-actions">
          <Button variant="primary" size="sm" onClick={confirm} data-testid="ai-order-confirm">
            {t('ai.order.confirm')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!editing) setDraft(base);
              setEditing(!editing);
            }}
            aria-pressed={editing}
            data-testid="ai-order-edit"
          >
            {editing ? t('ai.order.doneEditing') : t('ai.order.edit')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => decideOrder(callId, 'reject')}
            data-testid="ai-order-reject"
          >
            {t('ai.order.reject')}
          </Button>
        </div>
      ) : (
        <div className="ai-order-result" data-testid="ai-order-status">
          {status === 'placed' && <Badge kind="live">{t('ai.order.placed')}</Badge>}
          {status === 'rejected' && <Badge kind="error">{t('ai.order.rejected')}</Badge>}
          {status === 'failed' && <Badge kind="error">{t('ai.order.failed')}</Badge>}
          {status === 'auto' && <Badge kind="delayed">{t('ai.order.auto')}</Badge>}
          {status === 'sent' && <Badge>{t('ai.order.sending')}</Badge>}
          {resultText && status === 'failed' && <span className="ai-order-msg">{resultText}</span>}
        </div>
      )}
    </div>
  );
}
