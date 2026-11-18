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
import { registerModule, type ModuleViewProps } from '../registry';
import { registerCommands } from '../../shell/commands';
import { askConfirm } from '../../state/confirm';
import { useSetting } from '../../state/settings';
import { paper } from '../../state/market';
import { Markdown } from './Markdown';
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
      () => toast('success', 'Copied'),
      () => toast('error', 'Copy failed'),
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
              {m.hadImage && <Badge kind="live">screenshot sent</Badge>}
              {m.context && (
                <details>
                  <summary>screen context</summary>
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
                  Copy
                </button>
              )}
              {last && (
                <button type="button" onClick={onRegenerate} data-testid="ai-regenerate">
                  Regenerate
                </button>
              )}
              {m.usage && (
                <span className="tnum">
                  {m.usage.input} in · {m.usage.output} out
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
        title: 'Send a screenshot?',
        body: `A picture of the HT Flow window will be sent to ${cfg?.label ?? conv.provider} (${conv.model}). Other apps are never captured.`,
        confirmLabel: 'Send screenshot',
      });
    const t = text;
    setText('');
    if (shotPref !== 'auto') setShot(false);
    await send(conv, { text: t, screenshot: attach, context: ctx });
  };

  const last = conv.messages.length - 1;
  return (
    <div className="ai-chat col">
      <div className="ai-chat-head">
        <Select<string>
          aria-label="Provider"
          small
          value={conv.configId}
          onChange={(v) => patchConversation(conv.id, { configId: v })}
          options={st.configs.map((c) => ({
            value: c.id,
            label: `${c.label}${c.hasKey || !providerInfo(c.kind).needsKey ? '' : ' (no key)'}`,
          }))}
        />
        <Select<string>
          aria-label="Model"
          small
          value={conv.model}
          onChange={(v) => patchConversation(conv.id, { model: v })}
          options={(models.includes(conv.model) ? models : [conv.model, ...models])
            .filter(Boolean)
            .map((m) => ({ value: m, label: m }))}
        />
        <Select<string>
          aria-label="Preset"
          small
          value={conv.presetId}
          onChange={(v) => patchConversation(conv.id, { presetId: v })}
          options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
      </div>
      {conv.presetId === 'custom' && (
        <textarea
          className="ai-system"
          aria-label="System prompt"
          placeholder="System prompt…"
          value={conv.system}
          onChange={(e) => patchConversation(conv.id, { system: e.target.value })}
        />
      )}
      <div className="ai-messages" ref={listRef} data-testid="ai-messages">
        {conv.messages.length === 0 && (
          <div className="ai-empty">
            Ask about your chart, order flow or risk. Your own API key is used; nothing goes through
            an HT Flow server.
          </div>
        )}
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
          <Checkbox checked={ctx} onChange={setCtx} label="Screen context" />
          <Button
            size="sm"
            variant={shot ? 'primary' : 'outline'}
            disabled={!vision || shotPref === 'never'}
            onClick={() => setShot(!shot)}
            data-testid="ai-shot-toggle"
            title={
              !vision
                ? 'This model cannot read images'
                : shotPref === 'never'
                  ? 'Screenshots are off (Settings → Privacy)'
                  : 'Attach a screenshot of the HT Flow window'
            }
          >
            📷 See my screen
          </Button>
          {shot && (
            <span className="ai-shot-chip" data-testid="ai-shot-chip">
              Screenshot will be attached{shotPref === 'ask' ? ' (you confirm first)' : ''}
              <button type="button" aria-label="Remove screenshot" onClick={() => setShot(false)}>
                ×
              </button>
            </span>
          )}
        </div>
        <div className="ai-composer-row">
          <textarea
            aria-label="Message"
            data-testid="ai-input"
            value={text}
            placeholder="Ask the AI… (Enter to send, Shift+Enter for a new line)"
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
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void submit()} data-testid="ai-send">
              Send
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
          + New chat
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
                aria-label={`Delete ${c.title}`}
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
            Start a chat
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
          {st.agentRunning ? 'Agent running' : 'Agent stopped'}
        </Badge>
        {guard.isKilled && <Badge kind="error">Kill switch on</Badge>}
        {guard.isLiveArmed && <Badge kind="delayed">Live armed</Badge>}
        {st.nextRunAt && (
          <span className="tnum">next run {new Date(st.nextRunAt).toLocaleTimeString()}</span>
        )}
        <span className="grow" />
        {st.agentRunning ? (
          <Button onClick={stopAgent} data-testid="ai-agent-stop">
            Stop agent
          </Button>
        ) : (
          <Button variant="primary" onClick={() => startAgent()} data-testid="ai-agent-start">
            Start agent
          </Button>
        )}
        <Button variant="destructive" onClick={killSwitch} data-testid="ai-kill">
          Kill switch
        </Button>
        {guard.isKilled && (
          <Button variant="outline" onClick={() => guard.resetKill()} data-testid="ai-kill-reset">
            Reset kill switch
          </Button>
        )}
      </div>
      <div className="ai-form">
        <label>
          Account
          <Select<string>
            aria-label="Agent account"
            value={a.accountId}
            onChange={(v) => setAgent({ accountId: v })}
            options={[...paper.accounts.values()].map((x) => ({
              value: x.id,
              label: `${x.name} (${x.kind})`,
            }))}
          />
        </label>
        <label>
          Provider for scheduled runs
          <span className="ai-hint">
            The agent uses the provider and model of its conversation; defaults to your first
            provider with a key.
          </span>
        </label>
        <label>
          Run every (seconds)
          <NumberInput
            aria-label="Interval seconds"
            value={a.intervalSec}
            min={30}
            max={86400}
            step={30}
            onChange={(v) => setAgent({ intervalSec: v })}
          />
        </label>
        <label>
          Max steps per run
          <NumberInput
            aria-label="Max steps"
            value={a.maxSteps}
            min={1}
            max={20}
            onChange={(v) => setAgent({ maxSteps: v })}
          />
        </label>
        <label className="ai-wide">
          Goal / rules
          <textarea
            aria-label="Agent goal"
            value={a.goal}
            onChange={(e) => setAgent({ goal: e.target.value })}
          />
        </label>
      </div>
      <h4>Hard limits (enforced by the paper engine's pre-trade checks)</h4>
      <div className="ai-form">
        <label>
          Max quantity per order
          <NumberInput
            aria-label="Max quantity"
            value={l.maxQty}
            min={0.000001}
            step={1}
            onChange={(v) => setLimits({ maxQty: v })}
          />
        </label>
        <label>
          Max orders per hour
          <NumberInput
            aria-label="Max orders per hour"
            value={l.maxOrdersPerHour}
            min={1}
            max={1000}
            onChange={(v) => setLimits({ maxOrdersPerHour: v })}
          />
        </label>
        <label>
          Daily loss stop
          <NumberInput
            aria-label="Daily loss stop"
            value={l.dailyLossStop}
            min={1}
            step={50}
            onChange={(v) => setLimits({ dailyLossStop: v })}
          />
        </label>
        <label>
          Allowed symbols (empty = any)
          <Input
            aria-label="Allowed symbols"
            value={symbols}
            placeholder="BTCUSDT, ESZ6"
            onChange={(e) => setSymbols(e.target.value)}
            onBlur={() => setLimits({ allowedSymbols: parseSymbols(symbols) })}
          />
        </label>
        <Checkbox
          checked={l.confirmEachTrade}
          onChange={(v) => setLimits({ confirmEachTrade: v })}
          label="Confirm each trade"
        />
      </div>
      <div className="ai-live">
        <Toggle
          checked={guard.isLiveArmed}
          label="Arm live trading for this session"
          onChange={async (on) => {
            if (!on) return guard.armLive(false);
            const ok = await askConfirm({
              title: 'Arm live trading?',
              body: 'The AI agent will be allowed to place real orders on live (non-paper) accounts until you close HT Flow, log out or press the kill switch. Hard limits still apply.',
              confirmLabel: 'Arm live trading',
              danger: true,
            });
            if (ok) guard.armLive(true);
          }}
        />
        <span className="ai-hint">
          {live
            ? 'The selected account is live: arming is required.'
            : 'Paper accounts never need arming. Live arming is never saved.'}
        </span>
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
        <span>{rows.length} tool calls</span>
        <span className="grow" />
        <Button size="sm" variant="outline" onClick={clearAudit}>
          Clear
        </Button>
      </div>
      <table className="ai-audit-table tnum">
        <thead>
          <tr>
            <th>Time</th>
            <th>Mode</th>
            <th>Tool</th>
            <th>Arguments</th>
            <th>Result</th>
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
      toast('success', `${m.length} models`, c.label);
    } catch (e) {
      toast('error', 'Could not list models', errorText(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="ai-provider" data-testid={`ai-provider-${c.id}`}>
      <div className="ai-provider-head">
        <strong>{c.label}</strong>
        {info.local && <Badge>local</Badge>}
        {c.hasKey ? (
          <Badge kind="live">key saved</Badge>
        ) : info.needsKey ? (
          <Badge kind="error">no key</Badge>
        ) : null}
        <span className="grow" />
        {c.kind === 'custom' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfigs(ai.state().configs.filter((x) => x.id !== c.id))}
          >
            Remove
          </Button>
        )}
      </div>
      <div className="ai-form">
        <label>
          API key {info.needsKey ? '' : '(optional)'}
          <div className="row">
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${c.label} API key`}
              placeholder={c.hasKey ? '•••••••• (saved in the encrypted vault)' : info.keyHint}
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
                  toast('success', 'Key saved', 'Stored in your encrypted vault');
                } catch (e) {
                  toast('error', 'Could not save the key', errorText(e));
                }
              }}
            >
              Save key
            </Button>
            {c.hasKey && (
              <Button size="sm" variant="ghost" onClick={() => void saveKey(c.id, '')}>
                Forget
              </Button>
            )}
          </div>
        </label>
        <label>
          Base URL
          <Input
            aria-label={`${c.label} base URL`}
            value={base}
            placeholder={info.baseUrl || 'https://your-endpoint/v1'}
            invalid={!!urlErr}
            onChange={(e) => setBase(e.target.value)}
            onBlur={() => !urlErr && updateConfig(c.id, { baseUrl: base.trim() })}
          />
          {urlErr && <span className="ai-error">{urlErr}</span>}
        </label>
        <label className="ai-wide">
          Models (one per line)
          <textarea
            aria-label={`${c.label} models`}
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
            {loading ? 'Loading…' : 'Fetch model list'}
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
        Bring your own key: calls go straight from this PC to the provider (https only; local models
        on localhost). Keys are stored only in your encrypted vault and never in settings, logs or
        crash reports.
        {aiNative.kind === 'none' &&
          ' The browser preview cannot reach providers; use the desktop app.'}
      </p>
      <div className="row">
        <Select<ProviderKind>
          aria-label="Add provider"
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
                label: kind === 'custom' ? `Custom ${id.split('-').pop()}` : `${info.label} (2)`,
                baseUrl: info.baseUrl,
                models: [...info.models],
                defaultModel: info.models[0] ?? '',
                hasKey: false,
              },
            ]);
          }}
        >
          Add endpoint
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
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { value: 'chat', label: 'Chat' },
          { value: 'agent', label: 'Agent' },
          { value: 'audit', label: 'Audit log' },
          { value: 'providers', label: 'Providers' },
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
    label: 'AI: Open assistant',
    group: 'Platform',
    keywords: 'llm chat gpt claude gemini grok',
    run: openAi,
  },
  {
    id: 'ai.ask-chart',
    label: 'AI: Ask about this chart',
    group: 'Chart',
    keywords: 'llm screenshot analyse explain',
    run: () => {
      pendingAsk = 'What do you see on my chart? Summarise structure, order flow and key levels.';
      openAi();
      if (!activeConversation()) newConversation();
      setTimeout(() => askListeners.forEach((l) => l()), 0);
    },
  },
  {
    id: 'ai.agent.start',
    label: 'AI: Start agent',
    group: 'Trading',
    keywords: 'llm automated bot',
    run: () => void startAgent(),
  },
  { id: 'ai.agent.stop', label: 'AI: Stop agent', group: 'Trading', run: stopAgent },
  {
    id: 'ai.kill',
    label: 'AI: Kill switch (stop agent, block AI orders)',
    group: 'Trading',
    keywords: 'emergency stop llm agent',
    run: killSwitch,
  },
]);
