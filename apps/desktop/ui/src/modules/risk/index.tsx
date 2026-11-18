import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Input, toast } from '@htflow/ui-kit';
import {
  RISK_PRESETS,
  defaultRiskRules,
  validateRiskRules,
  type NumRule,
  type RiskRuleId,
  type RiskRules,
} from '@htflow/trading';
import { paper } from '../../state/market';
import { activeAccount } from '../../trading/accounts';
import { registerModule } from '../registry';
import { localTimeZone, newsFeed, risk, riskStore } from './engine';
import { calendar } from '../calendar/store';
import { useStore } from '../rss/shared';
import './styles.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
const RULES: { id: RiskRuleId; label: string; action: string; unit: string }[] = [
  {
    id: 'dailyLossLimit',
    label: 'Daily loss limit',
    action: 'Auto-flatten + lock until tomorrow',
    unit: '$',
  },
  { id: 'trailingDrawdown', label: 'Trailing max drawdown', action: 'Lock account', unit: '$' },
  {
    id: 'maxPositionSize',
    label: 'Max position size (per instrument)',
    action: 'Reject order',
    unit: 'contracts',
  },
  { id: 'maxOrdersPerMinute', label: 'Max orders per minute', action: 'Reject order', unit: '' },
  { id: 'maxTradesPerDay', label: 'Max trades per day', action: 'Warn, then lock', unit: '' },
  { id: 'tradingHours', label: 'Trading hours', action: 'Block outside', unit: '' },
  {
    id: 'profitTarget',
    label: 'Profit target lock',
    action: 'Stop trading for the day',
    unit: '$',
  },
  {
    id: 'newsFlatten',
    label: 'Flatten before news (high impact)',
    action: 'Auto-flatten',
    unit: 'min',
  },
];

const usd = (v: number) =>
  (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

/** Re-renders on risk / paper changes and twice a second for mark-to-market. */
export function useRiskTicker(ms = 500): void {
  const [, set] = useState(0);
  useEffect(() => {
    const bump = () => set((x) => x + 1);
    const a = riskStore.subscribe(bump);
    const b = paper.subscribe(bump);
    const i = setInterval(bump, ms);
    return () => {
      a();
      b();
      clearInterval(i);
    };
  }, [ms]);
}

function Meter({
  label,
  text,
  used,
  testId,
}: {
  label: string;
  text: string;
  used: number;
  testId?: string;
}) {
  const pct = Math.min(1, Math.max(0, used));
  const color = pct >= 0.8 ? 'var(--ht-down)' : pct >= 0.5 ? 'var(--ht-warning)' : 'var(--ht-up)';
  return (
    <div className="risk-card" data-testid={testId}>
      <span className="muted">{label}</span>
      <b className="tnum">{text}</b>
      <div className="risk-bar">
        <span style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  );
}

function PasswordDialog({
  open,
  title,
  description,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  onSubmit(pw: string): Promise<string | null>;
  onClose(): void;
}) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPw('');
      setErr(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      width={380}
    >
      <form
        className="col gap12"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await onSubmit(pw);
          if (r) setErr(r);
          else onClose();
        }}
      >
        <Field label={tl('Override password')} error={err}>
          <Input
            type="password"
            value={pw}
            autoFocus
            data-testid="risk-password"
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary">
          {tl('Confirm')}
        </Button>
      </form>
    </Dialog>
  );
}

function RiskWindow({ account, setAccount }: { account: string; setAccount(a: string): void }) {
  useRiskTicker();
  const accounts = [...paper.accounts.values()];
  const acc = paper.accounts.get(account) ?? accounts[0]!;
  const saved = risk.rules(acc.id);
  const [draft, setDraft] = useState<RiskRules>(saved);
  const [dirty, setDirty] = useState(false);
  const [ask, setAsk] = useState<null | 'save' | 'unlock' | 'set'>(null);
  // Follow the engine while the user has no unsaved edits (account switch, load from settings).
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);
  const st = risk.status(acc.id);
  const edit = (r: RiskRules) => {
    setDraft(r);
    setDirty(true);
  };
  const errors = validateRiskRules(draft);
  const [toAll, setToAll] = useState(false);
  const commit = () => {
    if (toAll) {
      const n = riskStore.saveRulesForAll(draft);
      toast('success', tl('Risk rules saved'), tt`All ${n} paper accounts (and new ones)`);
    } else {
      riskStore.saveRules(acc.id, draft);
      toast('success', tl('Risk rules saved'), acc.name);
    }
    setDirty(false);
  };
  const cal = useStore(calendar);
  const news = newsFeed();
  const nextNews = news.find((n) => n.ts > Date.now());
  const usedPct = Math.round(st.dailyLossUsed * 100);
  const badge = st.locked
    ? 'Locked'
    : draft.dailyLossLimit.enabled
      ? `${usedPct}% of daily loss used`
      : 'Daily loss limit off';
  return (
    <div className="module-window risk-win" data-testid="risk-window">
      <div className="risk-head">
        <select
          className="ht-select ht-select--sm"
          aria-label={tl('Account')}
          value={acc.id}
          onChange={(e) => {
            setAccount(e.target.value);
            setDirty(false);
          }}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="grow" />
        <span className={`risk-badge risk-badge--${st.state}`} data-testid="risk-usage">
          {badge}
        </span>
      </div>
      {st.locked && (
        <div className="risk-lock" data-testid="risk-locked">
          <span className="grow">
            {st.lockReason}
            {st.lockedUntil ? ` · unlocks ${new Date(st.lockedUntil).toLocaleString()}` : ''}
          </span>
          <Button
            size="xs"
            onClick={() => (riskStore.hasOverride() ? setAsk('unlock') : riskStore.unlock(acc.id))}
          >
            {tl('Unlock (override)')}
          </Button>
        </div>
      )}
      <div className="risk-meters">
        <Meter
          testId="risk-meter-daily"
          label={tl('Daily loss')}
          text={`${usd(Math.min(0, st.dayPnl))} / ${draft.dailyLossLimit.enabled ? usd(draft.dailyLossLimit.value) : 'off'}`}
          used={st.dailyLossUsed}
        />
        <Meter
          label={tl('Trailing drawdown')}
          text={`${usd(st.drawdown)} / ${draft.trailingDrawdown.enabled ? usd(draft.trailingDrawdown.value) : 'off'}`}
          used={st.trailingUsed}
        />
        <Meter
          label={tl('Trades today')}
          text={`${st.tradesToday} / ${draft.maxTradesPerDay.enabled ? draft.maxTradesPerDay.value : '∞'}`}
          used={draft.maxTradesPerDay.enabled ? st.tradesToday / draft.maxTradesPerDay.value : 0}
        />
      </div>
      <div className="risk-rules">
        {RULES.map((r) => {
          const rule = draft[r.id];
          return (
            <label key={r.id} className="risk-rule">
              <input
                type="checkbox"
                checked={rule.enabled}
                aria-label={tl(r.label)}
                onChange={(e) => edit({ ...draft, [r.id]: { ...rule, enabled: e.target.checked } })}
              />
              <span className="risk-rule-name">{tl(r.label)}</span>
              <span className="risk-rule-val">
                {r.id === 'tradingHours' ? (
                  <>
                    <input
                      type="time"
                      className="ht-input risk-in"
                      value={draft.tradingHours.start}
                      onChange={(e) =>
                        edit({
                          ...draft,
                          tradingHours: { ...draft.tradingHours, start: e.target.value },
                        })
                      }
                    />
                    –
                    <input
                      type="time"
                      className="ht-input risk-in"
                      value={draft.tradingHours.end}
                      onChange={(e) =>
                        edit({
                          ...draft,
                          tradingHours: { ...draft.tradingHours, end: e.target.value },
                        })
                      }
                    />
                    <span className="muted">{draft.timeZone}</span>
                  </>
                ) : (
                  <>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      className="ht-input risk-in tnum"
                      data-testid={`risk-value-${r.id}`}
                      value={
                        Number.isFinite((rule as NumRule).value) ? (rule as NumRule).value : ''
                      }
                      onChange={(e) =>
                        edit({
                          ...draft,
                          [r.id]: { ...rule, value: parseFloat(e.target.value) },
                        })
                      }
                    />
                    <span className="muted">{r.unit}</span>
                  </>
                )}
              </span>
              <span className="muted risk-rule-action">{r.action}</span>
            </label>
          );
        })}
      </div>
      <div className="risk-news muted" data-testid="risk-news-feed">
        <span className="grow">
          {tl('News feed: Economic Calendar ·')} {news.length} {tl('high-impact event')}
          {news.length === 1 ? '' : 's'} {tl('this week')}
          {nextNews ? ` · next: ${nextNews.title} ${new Date(nextNews.ts).toLocaleString()}` : ''}
        </span>
        <label className="ht-check">
          <input
            type="checkbox"
            checked={cal.newsFlattenSample}
            data-testid="risk-news-sample"
            onChange={(e) =>
              calendar.set({ ...calendar.get(), newsFlattenSample: e.target.checked })
            }
          />
          {tl('Count SAMPLE events')}
        </label>
      </div>
      {errors.length > 0 && <div className="risk-err">{errors.join(' · ')}</div>}
      <div className="risk-foot">
        <select
          className="ht-select ht-select--sm"
          aria-label={tl('Preset')}
          value=""
          onChange={(e) => {
            const tz = localTimeZone();
            const p = RISK_PRESETS.find((x) => x.id === e.target.value);
            edit(p ? p.rules(tz) : defaultRiskRules(tz));
          }}
        >
          <option value="" disabled>
            {tl('Preset…')}
          </option>
          {RISK_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {tl(p.label)}
            </option>
          ))}
          <option value="default">{tl('Reset to defaults')}</option>
        </select>
        <span className="grow" />
        <label
          className="ht-check"
          title={tl('Save these rules to every paper account and use them for new accounts')}
        >
          <input
            type="checkbox"
            checked={toAll}
            data-testid="risk-apply-all"
            onChange={(e) => {
              setToAll(e.target.checked);
              setDirty(true);
            }}
          />
          {tl('Apply to all paper accounts')}
        </label>
        <Button size="sm" variant="outline" onClick={() => setAsk('set')}>
          {tl('Override password…')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={errors.length > 0 || !dirty}
          data-testid="risk-save"
          onClick={() => (riskStore.hasOverride() ? setAsk('save') : commit())}
        >
          {tl('Save rules')}
        </Button>
      </div>
      <PasswordDialog
        open={ask !== null}
        title={ask === 'set' ? 'Override password' : 'Enter override password'}
        description={
          ask === 'set'
            ? 'Required to change rules or unlock a locked account. Only a salted SHA-256 hash is stored. Leave empty to remove it.'
            : 'This account is protected by an override password.'
        }
        onClose={() => setAsk(null)}
        onSubmit={async (pw) => {
          if (ask === 'set') {
            if (pw && pw.length < 4) return 'Use at least 4 characters';
            await riskStore.setOverride(pw || null);
            toast('success', pw ? 'Override password set' : 'Override password removed');
            return null;
          }
          if (!(await riskStore.checkOverride(pw))) return 'Wrong password';
          if (ask === 'save') commit();
          else riskStore.unlock(acc.id);
          return null;
        }}
      />
    </div>
  );
}

registerModule({
  id: 'risk',
  view: function RiskModule({ state, setParams }) {
    const account = (state.params?.account as string | undefined) ?? activeAccount();
    return <RiskWindow account={account} setAccount={(a) => setParams({ account: a })} />;
  },
});
