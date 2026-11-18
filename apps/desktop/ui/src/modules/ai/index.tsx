import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Input,
  NumberInput,
  Select,
  Tabs,
  Toggle,
  toast,
} from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
import { registerModule, type ModuleViewProps } from '../registry';
import { registerCommands } from '../../shell/commands';
import { askConfirm } from '../../state/confirm';
import { useSetting } from '../../state/settings';
import { paper } from '../../state/market';
import { Markdown } from './MarkdownView';
import { PRESETS, type ChatMsg, type Conversation } from './chat';
import { parseSymbols } from './guard';
import { aiNative, errorText } from './native';
import {
  checkBaseUrl,
  newCustomId,
  PROVIDERS,
  providerInfo,
  type ProviderConfig,
  type ProviderKind,
} from './providers';
import {
  activeConversation,
  ai,
  clearAudit,
  configById,
  deleteConversation,
  fetchModels,
  guard,
  isBusy,
  killSwitch,
  newConversation,
  patchConversation,
  regenerate,
  saveKey,
  selectConversation,
  send,
  setAgent,
  setConfigs,
  startAgent,
  stop,
  stopAgent,
  supportsVision,
  updateConfig,
} from './runtime';
import './styles.css';

type Tab = 'chat' | 'agent' | 'audit' | 'providers';

function useAi() {
  return useSyncExternalStore(ai.subscribe, ai.version);
}

/** Prompt queued by "Ask about this chart" for the next time the window renders. */
let pendingAsk: string | null = null;
const askListeners = new Set<() => void>();

const openAi = () => window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'ai' }));

/* ------------------------------------------------------------------ chat */

function MessageView({
  m,
  last,
  onRegenerate,
}: {
  m: ChatMsg;
  last: boolean;
  onRegenerate(): void;
}) {
  const copy = () =>
    navigator.clipboard.writeText(m.text).then(
      () => toast('success', t('ai.copied')),
      () => toast('error', t('ai.copyFailed')),
    );
  if (m.role === 'tool')
    return (
      <div className="ai-msg ai-msg--tool" data-testid="ai-tool-msg">
        <pre>{m.text.trim() || '…'}</pre>
      </div>
    );
  return (
    <div className={`ai-msg ai-msg--${m.role}`} data-testid={`ai-msg-${m.role}`}>
      {m.role === 'user' ? (
        <>
          <div className="ai-user-text">{m.text}</div>
          {(m.hadImage || m.context) && (
            <div className="ai-attach">
              {m.hadImage && <Badge kind="live">{t('ai.screenshotSent')}</Badge>}
              {m.context && (
                <details>
                  <summary>{t('ai.screenContextSummary')}</summary>
                  <pre>{m.context}</pre>
                </details>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {m.text ? (
            <Markdown text={m.text} />
          ) : m.pending ? (
            <div className="ai-typing">…</div>
          ) : null}
          {m.toolCalls?.map((c) => (
            <div key={c.id} className="ai-toolcall tnum">
              ⚙ {c.name}({JSON.stringify(c.arguments)})
            </div>
          ))}
          {m.error && (
            <div className="ai-error" role="alert">
              {m.error}
            </div>
          )}
          {!m.pending && (m.text || m.error) && (
            <div className="ai-msg-actions">
              {m.text && (
                <button type="button" onClick={copy}>
                  {t('ai.copy')}
                </button>
              )}
              {last && (
                <button type="button" onClick={onRegenerate} data-testid="ai-regenerate">
                  {t('ai.regenerate')}
                </button>
              )}
              {m.usage && (
                <span className="tnum">
                  {t('ai.usage', { input: m.usage.input, output: m.usage.output })}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ChatPane({ conv }: { conv: Conversation }) {
  useAi();
  const st = ai.state();
  const shotPref = useSetting('privacy.aiScreenshot');
  const ctxPref = useSetting('privacy.aiContext');
  const [text, setText] = useState('');
  const [shot, setShot] = useState(false);
  const [ctx, setCtx] = useState(ctxPref);
  const busy = isBusy(conv.id);
  const vision = supportsVision(conv);
  const listRef = useRef<HTMLDivElement>(null);
  const cfg = configById(conv.configId);
  const models = cfg?.models.length ? cfg.models : [conv.model].filter(Boolean);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const take = () => {
      if (pendingAsk === null) return;
      setText(pendingAsk);
      pendingAsk = null;
      setCtx(true);
      if (vision && shotPref !== 'never') setShot(true);
    };
    take();
    askListeners.add(take);
    return () => void askListeners.delete(take);
  }, [vision, shotPref]);

  useEffect(() => {
    if (shotPref === 'auto' && vision) setShot(true);
    if (shotPref === 'never' || !vision) setShot(false);
  }, [shotPref, vision]);

  const submit = async () => {
    if (busy || (!text.trim() && !shot)) return;
    let attach = shot && vision && shotPref !== 'never';
    if (attach && shotPref === 'ask')
      attach = await askConfirm({
        title: t('ai.shotConfirmTitle'),
        body: t('ai.shotConfirmBody', { provider: cfg?.label ?? conv.provider, model: conv.model }),
        confirmLabel: t('ai.shotConfirmOk'),
      });
    const msg = text;
    setText('');
    if (shotPref !== 'auto') setShot(false);
    await send(conv, { text: msg, screenshot: attach, context: ctx });
  };

  const last = conv.messages.length - 1;
  return (
    <div className="ai-chat col">
      <div className="ai-chat-head">
        <Select<string>
          aria-label={t('ai.provider')}
          small
          value={conv.configId}
          onChange={(v) => patchConversation(conv.id, { configId: v })}
          options={st.configs.map((c) => ({
            value: c.id,
            label: `${c.label}${c.hasKey || !providerInfo(c.kind).needsKey ? '' : t('ai.noKeySuffix')}`,
          }))}
        />
        <Select<string>
          aria-label={t('ai.model')}
          small
          value={conv.model}
          onChange={(v) => patchConversation(conv.id, { model: v })}
          options={(models.includes(conv.model) ? models : [conv.model, ...models])
            .filter(Boolean)
            .map((m) => ({ value: m, label: m }))}
        />
        <Select<string>
          aria-label={t('ai.preset')}
          small
          value={conv.presetId}
          onChange={(v) => patchConversation(conv.id, { presetId: v })}
          options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
      </div>
      {conv.presetId === 'custom' && (
        <textarea
          className="ai-system"
          aria-label={t('ai.systemPrompt')}
          placeholder={t('ai.systemPromptPlaceholder')}
          value={conv.system}
          onChange={(e) => patchConversation(conv.id, { system: e.target.value })}
        />
      )}
      <div className="ai-messages" ref={listRef} data-testid="ai-messages">
        {conv.messages.length === 0 && <div className="ai-empty">{t('ai.emptyChat')}</div>}
        {conv.messages.map((m, i) => (
          <MessageView
            key={m.id}
            m={m}
            last={i === last && m.role === 'assistant' && !busy}
            onRegenerate={() => void regenerate(conv)}
          />
        ))}
      </div>
      <div className="ai-composer">
        <div className="ai-composer-opts">
          <Checkbox checked={ctx} onChange={setCtx} label={t('ai.screenContext')} />
          <Button
            size="sm"
            variant={shot ? 'primary' : 'outline'}
            disabled={!vision || shotPref === 'never'}
            onClick={() => setShot(!shot)}
            data-testid="ai-shot-toggle"
            title={
              !vision
                ? t('ai.noImages')
                : shotPref === 'never'
                  ? t('ai.screenshotsOff')
                  : t('ai.attachShot')
            }
          >
            {t('ai.seeScreen')}
          </Button>
          {shot && (
            <span className="ai-shot-chip" data-testid="ai-shot-chip">
              {t('ai.shotAttached')}
              {shotPref === 'ask' ? t('ai.shotConfirmFirst') : ''}
              <button type="button" aria-label={t('ai.removeShot')} onClick={() => setShot(false)}>
                ×
              </button>
            </span>
          )}
        </div>
        <div className="ai-composer-row">
          <textarea
            aria-label={t('ai.message')}
            data-testid="ai-input"
            value={text}
            placeholder={t('ai.inputPlaceholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {busy ? (
            <Button variant="destructive" onClick={() => stop(conv.id)} data-testid="ai-stop">
              {t('ai.stop')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void submit()} data-testid="ai-send">
              {t('ai.send')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatTab() {
  useAi();
  const st = ai.state();
  const conv = activeConversation();
  return (
    <div className="ai-chat-layout">
      <div className="ai-convs col">
        <Button size="sm" variant="primary" onClick={() => newConversation()} data-testid="ai-new">
          {t('ai.newChat')}
        </Button>
        <div className="ai-conv-list">
          {st.convs.map((c) => (
            <div
              key={c.id}
              className={`ai-conv${c.id === st.activeId ? ' is-active' : ''}`}
              onClick={() => selectConversation(c.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && selectConversation(c.id)}
            >
              <span className="ai-conv-title">{c.title}</span>
              <span className="ai-conv-meta">{c.model}</span>
              <button
                type="button"
                aria-label={t('ai.deleteChat', { title: c.title })}
                onClick={(e) => {
                  e.stopPropagation();
                  deleteConversation(c.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      {conv ? (
        <ChatPane key={conv.id} conv={conv} />
      ) : (
        <div className="ai-empty">
          <Button variant="primary" onClick={() => newConversation()}>
            {t('ai.startChat')}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ agent */

function AgentTab() {
  useAi();
  const st = ai.state();
  const a = st.agent;
  const l = a.limits;
  const [symbols, setSymbols] = useState(l.allowedSymbols.join(', '));
  const acc = paper.accounts.get(a.accountId);
  const live = acc ? acc.kind !== 'paper' : false;
  const setLimits = (p: Partial<typeof l>) => setAgent({ limits: { ...l, ...p } });
  return (
    <div className="ai-agent col" data-testid="ai-agent">
      <div className="ai-agent-status">
        <Badge kind={st.agentRunning ? 'live' : 'default'}>
          {st.agentRunning ? t('ai.agentRunning') : t('ai.agentStopped')}
        </Badge>
        {guard.isKilled && <Badge kind="error">{t('ai.killOn')}</Badge>}
        {guard.isLiveArmed && <Badge kind="delayed">{t('ai.liveArmed')}</Badge>}
        {st.nextRunAt && (
          <span className="tnum">
            {t('ai.nextRun', { time: new Date(st.nextRunAt).toLocaleTimeString() })}
          </span>
        )}
        <span className="grow" />
        {st.agentRunning ? (
          <Button onClick={stopAgent} data-testid="ai-agent-stop">
            {t('ai.stopAgent')}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => startAgent()} data-testid="ai-agent-start">
            {t('ai.startAgent')}
          </Button>
        )}
        <Button variant="destructive" onClick={killSwitch} data-testid="ai-kill">
          {t('ai.killSwitch')}
        </Button>
        {guard.isKilled && (
          <Button variant="outline" onClick={() => guard.resetKill()} data-testid="ai-kill-reset">
            {t('ai.resetKill')}
          </Button>
        )}
      </div>
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
            placeholder="BTCUSDT, ESZ6"
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
    </div>
  );
}

/* ------------------------------------------------------------------ audit */

function AuditTab() {
  useAi();
  const rows = [...ai.state().audit].reverse();
  return (
    <div className="ai-audit col" data-testid="ai-audit">
      <div className="ai-audit-head">
        <span>{t('ai.toolCalls', { n: rows.length })}</span>
        <span className="grow" />
        <Button size="sm" variant="outline" onClick={clearAudit}>
          {t('ai.clear')}
        </Button>
      </div>
      <table className="ai-audit-table tnum">
        <thead>
          <tr>
            <th>{t('ai.col.time')}</th>
            <th>{t('ai.col.mode')}</th>
            <th>{t('ai.col.tool')}</th>
            <th>{t('ai.col.args')}</th>
            <th>{t('ai.col.result')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.ok ? '' : 'is-error'} data-testid="ai-audit-row">
              <td>{new Date(r.ts).toLocaleTimeString()}</td>
              <td>{r.mode}</td>
              <td>{r.tool}</td>
              <td className="ai-args">{r.args}</td>
              <td>{r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ providers */

function ProviderRow({ c }: { c: ProviderConfig }) {
  const info = providerInfo(c.kind);
  const [key, setKey] = useState('');
  const [base, setBase] = useState(c.baseUrl);
  const [models, setModels] = useState(c.models.join('\n'));
  const [loading, setLoading] = useState(false);
  const urlErr = checkBaseUrl(c.kind, base);
  const fetchList = async () => {
    setLoading(true);
    try {
      const m = await fetchModels(c.id);
      setModels(m.join('\n'));
      toast('success', t('ai.modelsFetched', { n: m.length }), c.label);
    } catch (e) {
      toast('error', t('ai.listFailed'), errorText(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="ai-provider" data-testid={`ai-provider-${c.id}`}>
      <div className="ai-provider-head">
        <strong>{c.label}</strong>
        {info.local && <Badge>{t('ai.local')}</Badge>}
        {c.hasKey ? (
          <Badge kind="live">{t('ai.keySaved')}</Badge>
        ) : info.needsKey ? (
          <Badge kind="error">{t('ai.noKey')}</Badge>
        ) : null}
        <span className="grow" />
        {c.kind === 'custom' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfigs(ai.state().configs.filter((x) => x.id !== c.id))}
          >
            {t('ai.remove')}
          </Button>
        )}
      </div>
      <div className="ai-form">
        <label>
          {t('ai.apiKey')}
          {info.needsKey ? '' : ` ${t('ai.optional')}`}
          <div className="row">
            <Input
              type="password"
              autoComplete="off"
              aria-label={t('ai.apiKeyOf', { label: c.label })}
              placeholder={c.hasKey ? t('ai.keyPlaceholderSaved') : info.keyHint}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!key.trim()}
              onClick={async () => {
                try {
                  await saveKey(c.id, key);
                  setKey('');
                  toast('success', t('ai.keySavedToast'), t('ai.keySavedBody'));
                } catch (e) {
                  toast('error', t('ai.keySaveFailed'), errorText(e));
                }
              }}
            >
              {t('ai.saveKey')}
            </Button>
            {c.hasKey && (
              <Button size="sm" variant="ghost" onClick={() => void saveKey(c.id, '')}>
                {t('ai.forget')}
              </Button>
            )}
          </div>
        </label>
        <label>
          {t('ai.baseUrl')}
          <Input
            aria-label={t('ai.baseUrlOf', { label: c.label })}
            value={base}
            placeholder={info.baseUrl || 'https://your-endpoint/v1'}
            invalid={!!urlErr}
            onChange={(e) => setBase(e.target.value)}
            onBlur={() => !urlErr && updateConfig(c.id, { baseUrl: base.trim() })}
          />
          {urlErr && <span className="ai-error">{urlErr}</span>}
        </label>
        <label className="ai-wide">
          {t('ai.modelsLabel')}
          <textarea
            aria-label={t('ai.modelsOf', { label: c.label })}
            value={models}
            onChange={(e) => setModels(e.target.value)}
            onBlur={() => {
              const list = models
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
              updateConfig(c.id, {
                models: list,
                defaultModel: list.includes(c.defaultModel) ? c.defaultModel : (list[0] ?? ''),
              });
            }}
          />
        </label>
        <div className="row">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void fetchList()}>
            {loading ? t('ai.loading') : t('ai.fetchModels')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProvidersTab() {
  useAi();
  const st = ai.state();
  const [kind, setKind] = useState<ProviderKind>('custom');
  return (
    <div className="ai-providers col" data-testid="ai-providers">
      <p className="ai-hint">
        {t('ai.providersHint')}
        {aiNative.kind === 'none' && ` ${t('ai.noBrowser')}`}
      </p>
      <div className="row">
        <Select<ProviderKind>
          aria-label={t('ai.addProvider')}
          value={kind}
          onChange={setKind}
          options={PROVIDERS.map((p) => ({ value: p.kind, label: p.label }))}
        />
        <Button
          size="sm"
          onClick={() => {
            const info = providerInfo(kind);
            const id = newCustomId(st.configs, kind);
            setConfigs([
              ...st.configs,
              {
                id,
                kind,
                label:
                  kind === 'custom'
                    ? t('ai.customLabel', { n: id.split('-').pop() ?? '' })
                    : `${info.label} (2)`,
                baseUrl: info.baseUrl,
                models: [...info.models],
                defaultModel: info.models[0] ?? '',
                hasKey: false,
              },
            ]);
          }}
        >
          {t('ai.addEndpoint')}
        </Button>
      </div>
      {st.configs.map((c) => (
        <ProviderRow key={c.id} c={c} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ window */

function AiWindow({ state, setParams }: ModuleViewProps) {
  const tab = (['chat', 'agent', 'audit', 'providers'] as Tab[]).includes(state.params?.tab as Tab)
    ? (state.params!.tab as Tab)
    : 'chat';
  useAi();
  useEffect(() => {
    if (!ai.state().convs.length) newConversation();
  }, []);
  return (
    <div className="ai-win col" data-testid="ai-window" data-ai-exclude="">
      <Tabs<Tab>
        value={tab}
        onChange={(v) => setParams({ tab: v })}
        tabs={[
          { value: 'chat', label: t('ai.tab.chat') },
          { value: 'agent', label: t('ai.tab.agent') },
          { value: 'audit', label: t('ai.tab.audit') },
          { value: 'providers', label: t('ai.tab.providers') },
        ]}
      />
      <div className="ai-body">
        {tab === 'chat' && <ChatTab />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'providers' && <ProvidersTab />}
      </div>
    </div>
  );
}

registerModule({ id: 'ai', view: AiWindow });

registerCommands([
  {
    id: 'ai.open',
    label: t('ai.cmd.open'),
    group: 'Platform',
    keywords: 'llm chat gpt claude gemini grok',
    run: openAi,
  },
  {
    id: 'ai.ask-chart',
    label: t('ai.cmd.askChart'),
    group: 'Chart',
    keywords: 'llm screenshot analyse explain',
    run: () => {
      pendingAsk = t('ai.askChartPrompt');
      openAi();
      if (!activeConversation()) newConversation();
      setTimeout(() => askListeners.forEach((l) => l()), 0);
    },
  },
  {
    id: 'ai.agent.start',
    label: t('ai.cmd.startAgent'),
    group: 'Trading',
    keywords: 'llm automated bot',
    run: () => void startAgent(),
  },
  { id: 'ai.agent.stop', label: t('ai.cmd.stopAgent'), group: 'Trading', run: stopAgent },
  {
    id: 'ai.kill',
    label: t('ai.cmd.kill'),
    group: 'Trading',
    keywords: 'emergency stop llm agent',
    run: killSwitch,
  },
]);
