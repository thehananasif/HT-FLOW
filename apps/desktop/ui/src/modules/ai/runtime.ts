/**
 * AI module state: provider configs, conversations, the agent (schedule, limits, kill switch)
 * and the audit log of every tool call. Persisted per user through backend.saveSettings
 * (encrypted profile); API keys go to the vault only.
 */
import { toast } from '@htflow/ui-kit';
import { backend } from '../../backend';
import { hub, paper, PAPER_ACCOUNT } from '../../state/market';
import { useSession } from '../../state/session';
import { askConfirm } from '../../state/confirm';
import { activeInstrument, useWindows } from '../../state/windows';
import { activityLog } from '../activity/log';
import { addAlert } from '../alerts/api';
import { getSetting } from '../../state/settings';
import {
  forSave,
  runTurn,
  sanitizeConversations,
  titleFrom,
  truncateFrom,
  truncateToLastUser,
  uid,
  type ChatMsg,
  type Conversation,
} from './chat';
import { captureWindow } from './capture';
import {
  collectSnapshot,
  formatContext,
  FULL_INCLUDE,
  sanitizeInclude,
  type ContextInclude,
} from './context';
import {
  AGENT_TAG,
  AgentGuard,
  installAgentGuard,
  sanitizeLimits,
  type AgentLimits,
} from './guard';
import { aiNative, errorText } from './native';
import { keyVaultName, providerInfo, sanitizeConfigs, type ProviderConfig } from './providers';
import {
  READ_TOOL_DEFS,
  runTool,
  TOOL_DEFS,
  TRADE_TOOLS,
  type ToolDeps,
  type ToolOutcome,
} from './tools';

import { translateLiteral as tl, tt } from '@htflow/i18n';
export interface AuditEntry {
  id: string;
  ts: number;
  mode: 'chat' | 'agent';
  conversationId: string;
  tool: string;
  args: string;
  ok: boolean;
  summary: string;
}

export interface AgentConfig {
  limits: AgentLimits;
  intervalSec: number;
  maxSteps: number;
  accountId: string;
  /** Standing instruction sent on every scheduled run. */
  goal: string;
}

const DEFAULT_AGENT: AgentConfig = {
  limits: sanitizeLimits({}),
  intervalSec: 300,
  maxSteps: 6,
  accountId: PAPER_ACCOUNT,
  goal: 'Review the active instrument. Trade only if order flow clearly supports it; otherwise report and wait.',
};

export function sanitizeAgent(raw: unknown): AgentConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentConfig>;
  const int = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  return {
    limits: sanitizeLimits(r.limits),
    intervalSec: int(r.intervalSec, DEFAULT_AGENT.intervalSec, 30, 86_400),
    maxSteps: int(r.maxSteps, DEFAULT_AGENT.maxSteps, 1, 20),
    accountId: typeof r.accountId === 'string' && r.accountId ? r.accountId : PAPER_ACCOUNT,
    goal: typeof r.goal === 'string' ? r.goal.slice(0, 4000) : DEFAULT_AGENT.goal,
  };
}

export const guard = new AgentGuard();

/** Result of the last "Test connection" of a provider. */
export interface Health {
  ok: boolean;
  /** Round-trip of the model-list request (ms). */
  ms: number;
  at: number;
  models?: number;
  error?: string;
}

/** An order the model proposed (`place_order`), shown as a card until the trader decides. */
export interface OrderProposal {
  /** The model's tool call id. */
  id: string;
  convId: string;
  mode: 'chat' | 'agent';
  args: Record<string, unknown>;
  /** `auto`: "confirm each trade" is off, the order goes straight through (card is informational). */
  status: 'pending' | 'confirmed' | 'rejected' | 'auto';
  ts: number;
}

interface State {
  configs: ProviderConfig[];
  convs: Conversation[];
  activeId: string | null;
  busy: Record<string, true>;
  audit: AuditEntry[];
  agent: AgentConfig;
  agentRunning: boolean;
  /** True once the agent was started in this session (distinguishes paused from idle). */
  agentStarted: boolean;
  agentConvId: string | null;
  nextRunAt: number | null;
  health: Record<string, Health>;
  orders: Record<string, OrderProposal>;
  include: ContextInclude;
  /** Bumped on every change (React subscription key). */
  v: number;
}

const INCLUDE_KEY = 'htflow.ai.include';

function loadInclude(): ContextInclude {
  try {
    return sanitizeInclude(JSON.parse(localStorage.getItem(INCLUDE_KEY) ?? 'null'));
  } catch {
    return { ...FULL_INCLUDE };
  }
}

const st: State = {
  configs: sanitizeConfigs(null),
  convs: [],
  activeId: null,
  busy: {},
  audit: [],
  agent: DEFAULT_AGENT,
  agentRunning: false,
  agentStarted: false,
  agentConvId: null,
  nextRunAt: null,
  health: {},
  orders: {},
  include: loadInclude(),
  v: 0,
};

const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function emit(save = false): void {
  st.v++;
  for (const l of listeners) l();
  if (save) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }
}

function persist(): void {
  if (!useSession.getState().session) return;
  void backend.saveSettings('ai.providers', st.configs);
  void backend.saveSettings('ai.conversations', forSave(st.convs));
  void backend.saveSettings('ai.agent', st.agent);
  void backend.saveSettings('ai.audit', st.audit.slice(-1000));
}

export const ai = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    const off = guard.subscribe(fn);
    return () => {
      listeners.delete(fn);
      off();
    };
  },
  version: () => st.v,
  state: (): Readonly<State> => st,
};

guard.subscribe(() => emit());

/* ------------------------------------------------------------------ load per user */

let loadedFor: string | null = null;
function onSession(): void {
  const id = useSession.getState().session?.profileId ?? null;
  if (id === loadedFor) return;
  loadedFor = id;
  stopAgent();
  guard.armLive(false);
  st.configs = sanitizeConfigs(null);
  st.convs = [];
  st.audit = [];
  st.activeId = null;
  st.agent = DEFAULT_AGENT;
  st.agentStarted = false;
  st.agentConvId = null;
  st.health = {};
  rejectOrders();
  emit();
  if (!id) return;
  void Promise.all([
    backend.loadSettings<unknown>('ai.providers'),
    backend.loadSettings<unknown>('ai.conversations'),
    backend.loadSettings<unknown>('ai.agent'),
    backend.loadSettings<AuditEntry[]>('ai.audit'),
  ]).then(([p, c, a, au]) => {
    if (loadedFor !== id) return;
    st.configs = sanitizeConfigs(p);
    st.convs = sanitizeConversations(c);
    st.activeId = st.convs[0]?.id ?? null;
    st.agent = sanitizeAgent(a);
    guard.setLimits(st.agent.limits);
    st.audit = Array.isArray(au) ? au.slice(-1000) : [];
    emit();
    void refreshKeyStatus();
  });
}
useSession.subscribe(onSession);
onSession();

/* ------------------------------------------------------------------ engine guard */

function dayPnl(accountId: string): number {
  const acc = paper.accounts.get(accountId);
  if (!acc) return 0;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  let pnl = 0;
  for (const f of paper.fills)
    if (f.accountId === accountId && f.ts >= since.getTime()) pnl += f.realized - f.commission;
  for (const p of paper.allPositions(accountId)) {
    const m = hub.peek(p.instrumentId)?.lastTrade?.px;
    if (m !== undefined) pnl += paper.unrealized(accountId, p.instrumentId, m);
  }
  return pnl;
}

installAgentGuard(paper, guard, dayPnl);

/* ------------------------------------------------------------------ providers */

export function setConfigs(c: ProviderConfig[]): void {
  st.configs = c;
  emit(true);
}

export function updateConfig(id: string, patch: Partial<ProviderConfig>): void {
  st.configs = st.configs.map((c) => (c.id === id ? { ...c, ...patch } : c));
  emit(true);
}

export function configById(id: string): ProviderConfig | undefined {
  return st.configs.find((c) => c.id === id);
}

export async function saveKey(configId: string, key: string): Promise<void> {
  await backend.vaultPut(keyVaultName(configId), key.trim());
  updateConfig(configId, { hasKey: key.trim().length > 0 });
}

async function refreshKeyStatus(): Promise<void> {
  for (const c of st.configs) {
    try {
      const has =
        aiNative.kind === 'tauri'
          ? await aiNative.keyStatus(c.id)
          : !!(await backend.vaultGet(keyVaultName(c.id)));
      if (has !== c.hasKey) updateConfig(c.id, { hasKey: has });
    } catch {
      /* locked */
    }
  }
}

export async function fetchModels(configId: string): Promise<string[]> {
  const c = configById(configId);
  if (!c) return [];
  const models = await aiNative.listModels(c.kind, { configId, baseUrl: c.baseUrl });
  if (models.length)
    updateConfig(configId, {
      models,
      defaultModel: models.includes(c.defaultModel) ? c.defaultModel : models[0]!,
    });
  return models;
}

/** "Test connection": lists the provider's models (a cheap authenticated call) and times it. */
export async function testConnection(configId: string): Promise<Health> {
  const t0 = performance.now();
  let h: Health;
  try {
    const models = await fetchModels(configId);
    h = { ok: true, ms: Math.round(performance.now() - t0), at: Date.now(), models: models.length };
  } catch (e) {
    h = { ok: false, ms: Math.round(performance.now() - t0), at: Date.now(), error: errorText(e) };
  }
  st.health = { ...st.health, [configId]: h };
  emit();
  return h;
}

/** What the trader's context checkboxes currently let the AI see. */
export function setInclude(patch: Partial<ContextInclude>): void {
  st.include = { ...st.include, ...patch };
  try {
    localStorage.setItem(INCLUDE_KEY, JSON.stringify(st.include));
  } catch {
    /* storage blocked: the choice lasts for this session */
  }
  emit();
}

/** First provider with a key (or a keyless local / custom one). */
export function preferredConfig(): ProviderConfig {
  return (
    st.configs.find((c) => c.hasKey) ??
    st.configs.find((c) => !providerInfo(c.kind).needsKey && c.models.length) ??
    st.configs[0]!
  );
}

/* ------------------------------------------------------------------ conversations */

export function newConversation(presetId = 'analyst', configId?: string): Conversation {
  const cfg = (configId && configById(configId)) || preferredConfig();
  const c: Conversation = {
    id: uid('conv'),
    title: 'New chat',
    configId: cfg.id,
    provider: cfg.kind,
    model: cfg.defaultModel,
    presetId,
    system: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  st.convs.unshift(c);
  st.activeId = c.id;
  emit(true);
  return c;
}

export function activeConversation(): Conversation | undefined {
  return st.convs.find((c) => c.id === st.activeId);
}

export function selectConversation(id: string): void {
  st.activeId = id;
  emit();
}

export function patchConversation(id: string, patch: Partial<Conversation>): void {
  const c = st.convs.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  if (patch.configId) {
    const cfg = configById(patch.configId);
    if (cfg) {
      c.provider = cfg.kind;
      if (!patch.model) c.model = cfg.defaultModel;
    }
  }
  emit(true);
}

export function renameConversation(id: string, title: string): void {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (t) patchConversation(id, { title: t });
}

export function togglePin(id: string): void {
  const c = st.convs.find((x) => x.id === id);
  if (c) patchConversation(id, { pinned: !c.pinned });
}

export function deleteConversation(id: string): void {
  stop(id);
  rejectOrders(id);
  for (const [k, o] of Object.entries(st.orders)) if (o.convId === id) delete st.orders[k];
  st.convs = st.convs.filter((c) => c.id !== id);
  if (st.activeId === id) st.activeId = st.convs[0]?.id ?? null;
  if (st.agentConvId === id) st.agentConvId = null;
  emit(true);
}

const signals = new Map<string, { stopped: boolean; requestId?: string }>();

export function isBusy(id: string): boolean {
  return !!st.busy[id];
}

export function stop(id: string): void {
  const s = signals.get(id);
  if (!s) return;
  s.stopped = true;
  rejectOrders(id);
  if (s.requestId) void aiNative.cancel(s.requestId);
}

/* ------------------------------------------------------------------ order proposals */

const deciders = new Map<string, (d: { args: Record<string, unknown> } | null) => void>();

/** Rejects every order card still waiting for the trader (of one conversation, or all). */
function rejectOrders(convId?: string): void {
  for (const [id, o] of Object.entries(st.orders)) {
    if (o.status !== 'pending' || (convId && o.convId !== convId)) continue;
    o.status = 'rejected';
    deciders.get(id)?.(null);
    deciders.delete(id);
  }
}

/** Confirm (optionally with edited arguments) or reject a pending order card. */
export function decideOrder(
  id: string,
  decision: 'confirm' | 'reject',
  edited?: Record<string, unknown>,
): void {
  const o = st.orders[id];
  if (!o || o.status !== 'pending') return;
  o.status = decision === 'confirm' ? 'confirmed' : 'rejected';
  if (decision === 'confirm' && edited) o.args = edited;
  const d = deciders.get(id);
  deciders.delete(id);
  d?.(decision === 'confirm' ? { args: o.args } : null);
  emit();
}

function awaitOrder(
  convId: string,
  mode: 'chat' | 'agent',
  id: string,
  args: unknown,
): Promise<{ args: Record<string, unknown> } | null> {
  const a =
    args && typeof args === 'object' && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};
  const auto = !guard.limits.confirmEachTrade;
  st.orders[id] = { id, convId, mode, args: a, status: auto ? 'auto' : 'pending', ts: Date.now() };
  emit();
  if (auto) return Promise.resolve({ args: a });
  return new Promise((resolve) => {
    deciders.set(id, resolve);
  });
}

/** Instrument, tick economics, last price and account kind for an order card. */
export function orderContext(args: Record<string, unknown>) {
  const id = resolveSymbol(typeof args.symbol === 'string' ? args.symbol : undefined);
  const s = id ? hub.peek(id) : undefined;
  const acc = paper.accounts.get(st.agent.accountId);
  const tickSize = s?.instrument.tickSize ?? 0;
  const last = s?.lastTrade?.px;
  return {
    instrumentId: id,
    symbol: s?.instrument.symbol ?? (typeof args.symbol === 'string' ? args.symbol : '—'),
    tickSize,
    tickValue: s?.instrument.tickValue ?? 0,
    precision: s?.instrument.pricePrecision ?? 2,
    last: last !== undefined && tickSize > 0 ? last * tickSize : null,
    accountName: acc?.name ?? st.agent.accountId,
    accountKind: acc?.kind ?? 'paper',
    currency: acc?.currency ?? 'USD',
  };
}

/** Why the agent limits would reject this order right now (shown on the card), or null. */
export function orderPreCheck(args: Record<string, unknown>): string | null {
  const ctx = orderContext(args);
  const qty = typeof args.qty === 'number' ? args.qty : Number(args.qty);
  return guard.check(
    { accountId: st.agent.accountId, instrumentId: ctx.instrumentId ?? '', qty },
    { accountKind: ctx.accountKind, dayPnl: dayPnl(st.agent.accountId), now: Date.now() },
  );
}

function audit(e: Omit<AuditEntry, 'id' | 'ts'>): void {
  st.audit.push({ ...e, id: uid('a'), ts: Date.now() });
  if (st.audit.length > 1000) st.audit.splice(0, st.audit.length - 1000);
  if (TRADE_TOOLS.has(e.tool))
    activityLog.add({
      type: 'info',
      account: st.agent.accountId,
      message: `AI ${e.tool}: ${e.summary}`,
    });
}

export function clearAudit(): void {
  st.audit = [];
  emit(true);
}

function resolveSymbol(symbol: string | undefined): string | null {
  if (!symbol) {
    // The AI window itself is usually the active one: fall back to the first chart.
    const chart = Object.values(useWindows.getState().windows).find((w) => w.kind === 'chart');
    return activeInstrument() ?? (chart && 'instrumentId' in chart ? chart.instrumentId : null);
  }
  if (symbol.includes(':')) return symbol;
  const s = symbol.toUpperCase();
  const store = hub.stores().find((x) => x.instrument.symbol.toUpperCase() === s);
  if (store) return store.instrument.id;
  const act = activeInstrument();
  return act && act.toUpperCase().endsWith(`:${s}`) ? act : null;
}

function toolDeps(mode: 'chat' | 'agent'): ToolDeps {
  return {
    paper,
    guard,
    accountId: () => st.agent.accountId,
    resolve: resolveSymbol,
    market: (id) => {
      const s = hub.peek(id);
      if (!s) return undefined;
      return {
        symbol: s.instrument.symbol,
        tickSize: s.instrument.tickSize,
        pricePrecision: s.instrument.pricePrecision,
        lastPx: s.lastTrade?.px,
        bestBid: s.book.bestBid,
        bestAsk: s.book.bestAsk,
        trades: s.trades,
      };
    },
    dayPnl,
    confirm: (summary) =>
      askConfirm({
        title: mode === 'agent' ? 'AI agent wants to trade' : 'AI wants to trade',
        body: summary,
        confirmLabel: 'Allow',
        danger: true,
      }),
    addAlert: (instrumentId, px, direction) => {
      const r = addAlert({ kind: 'price-cross', instrumentId, px, direction });
      return r.ok ? null : r.errors.join('; ');
    },
    now: Date.now,
  };
}

export interface SendOptions {
  text: string;
  /** Attach a screenshot of the app window (already confirmed by the user). */
  screenshot?: boolean;
  /** Attach the structured screen context. */
  context?: boolean;
  /** Images the trader dropped / pasted (consent already confirmed by the caller). */
  attachments?: NonNullable<ChatMsg['attachments']>;
  mode?: 'chat' | 'agent';
}

/** Whether the model of `conv` reads images. */
export function supportsVision(conv: Conversation): boolean {
  return providerInfo(conv.provider).vision(conv.model);
}

export async function send(conv: Conversation, opts: SendOptions): Promise<void> {
  if (st.busy[conv.id]) return;
  const mode = opts.mode ?? 'chat';
  const msg: ChatMsg = { id: uid('m'), role: 'user', text: opts.text.trim(), ts: Date.now() };
  if (opts.context)
    msg.context = formatContext(
      collectSnapshot(st.agent.accountId),
      Date.now(),
      mode === 'agent' ? FULL_INCLUDE : st.include,
    );
  if (opts.attachments?.length) {
    msg.attachments = opts.attachments;
    msg.hadImage = true;
  }
  if (opts.screenshot) {
    try {
      const cap = await captureWindow();
      msg.image = { mediaType: cap.mediaType, data: cap.data };
      msg.hadImage = true;
    } catch (e) {
      toast('warning', tl('Screenshot failed'), errorText(e));
    }
  }
  if (!msg.text && !msg.image && !msg.attachments?.length) return;
  if (!conv.messages.some((m) => m.role === 'user') && conv.title === 'New chat')
    conv.title = titleFrom(msg.text || 'Screenshot');
  conv.messages.push(msg);
  await turn(conv, mode);
}

/** Edits an earlier question: that message and everything after it is replaced. */
export async function editAndSend(conv: Conversation, msgId: string, opts: SendOptions) {
  if (st.busy[conv.id] || !truncateFrom(conv, msgId)) return;
  await send(conv, opts);
}

export async function regenerate(conv: Conversation): Promise<void> {
  if (st.busy[conv.id] || !truncateToLastUser(conv)) return;
  await turn(conv, 'chat');
}

async function turn(conv: Conversation, mode: 'chat' | 'agent'): Promise<void> {
  const cfg = configById(conv.configId);
  const signal = { stopped: false } as { stopped: boolean; requestId?: string };
  signals.set(conv.id, signal);
  st.busy[conv.id] = true;
  emit();
  const tools = mode === 'agent' ? TOOL_DEFS : getSetting('privacy.aiTools') ? READ_TOOL_DEFS : [];
  const deps = toolDeps(mode);
  try {
    await runTurn(conv, {
      native: aiNative,
      target: { configId: conv.configId, baseUrl: cfg?.baseUrl },
      tools,
      maxSteps: mode === 'agent' ? st.agent.maxSteps : 4,
      signal,
      onChange: () => emit(),
      runTool: async (name, args, callId) => {
        let a = args;
        let d = deps;
        let out: ToolOutcome;
        if (name === 'place_order') {
          // The order card is the confirmation: Confirm / Edit / Reject (or auto when
          // "confirm each trade" is off). The agent guard and risk engine still run in the tool.
          const decision = await awaitOrder(conv.id, mode, callId, args);
          if (decision) {
            a = decision.args;
            d = { ...deps, confirm: async () => true };
          }
          out = decision
            ? await runTool(name, a, d)
            : {
                ok: false,
                result: { error: 'Rejected: the user declined the order' },
                summary: 'Rejected: the user declined the order',
              };
        } else out = await runTool(name, a, d);
        audit({
          mode,
          conversationId: conv.id,
          tool: name,
          args: JSON.stringify(a ?? {}).slice(0, 2000),
          ok: out.ok,
          summary: out.summary,
        });
        emit(true);
        return out;
      },
    });
  } finally {
    // The screenshot is sent once; later turns only say one was attached.
    for (const m of conv.messages) if (m.image) delete m.image;
    signals.delete(conv.id);
    delete st.busy[conv.id];
    emit(true);
  }
}

/* ------------------------------------------------------------------ agent */

let timer: ReturnType<typeof setTimeout> | null = null;

export function setAgent(patch: Partial<AgentConfig>): void {
  st.agent = sanitizeAgent({ ...st.agent, ...patch });
  guard.setLimits(st.agent.limits);
  emit(true);
}

function agentConversation(): Conversation {
  let c = st.agentConvId ? st.convs.find((x) => x.id === st.agentConvId) : undefined;
  if (!c) {
    c = newConversation('agent');
    c.title = `Agent · ${new Date().toLocaleString()}`;
    st.agentConvId = c.id;
  }
  return c;
}

async function agentRun(): Promise<void> {
  if (!st.agentRunning) return;
  if (guard.isKilled) return stopAgent();
  const conv = agentConversation();
  if (!st.busy[conv.id]) {
    await send(conv, {
      text: `Scheduled agent run. Goal: ${st.agent.goal}`,
      context: true,
      screenshot: getSetting('privacy.aiScreenshot') === 'auto' && supportsVision(conv),
      mode: 'agent',
    });
  }
  if (st.agentRunning) {
    st.nextRunAt = Date.now() + st.agent.intervalSec * 1000;
    timer = setTimeout(() => void agentRun(), st.agent.intervalSec * 1000);
    emit();
  }
}

/** Realized P&L (after commission) of today's orders placed by the agent. */
export function agentDayPnl(now = Date.now()): number {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  let pnl = 0;
  for (const f of paper.fills)
    if (f.tag === AGENT_TAG && f.ts >= since.getTime()) pnl += f.realized - f.commission;
  return pnl;
}

/** Model calls the current / last agent run used, against its step limit. */
export function agentStepInfo(): { used: number; max: number } {
  const conv = st.agentConvId ? st.convs.find((c) => c.id === st.agentConvId) : undefined;
  let used = 0;
  if (conv) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i]!;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && (m.text || m.toolCalls?.length || m.pending)) used++;
    }
  }
  return { used, max: st.agent.maxSteps };
}

/** Largest open position of the agent account (units), for the max-quantity gauge. */
export function agentMaxPosition(): number {
  let m = 0;
  for (const p of paper.allPositions(st.agent.accountId)) m = Math.max(m, Math.abs(p.qty));
  return m;
}

export const agentDayPnlOfAccount = (): number => dayPnl(st.agent.accountId);

export function startAgent(): boolean {
  if (st.agentRunning) return true;
  if (guard.isKilled) {
    toast('error', tl('Kill switch is on'), tl('Reset the kill switch in AI → Agent first'));
    return false;
  }
  const acc = paper.accounts.get(st.agent.accountId);
  if (acc && acc.kind !== 'paper' && !guard.isLiveArmed) {
    toast(
      'error',
      tl('Live trading not armed'),
      tl('Arm live trading for this session or pick a paper account'),
    );
    return false;
  }
  st.agentRunning = true;
  st.agentStarted = true;
  emit();
  void agentRun();
  toast(
    'info',
    tl('AI agent started'),
    tt`Every ${st.agent.intervalSec} s on ${acc?.name ?? st.agent.accountId}`,
  );
  return true;
}

export function stopAgent(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const wasRunning = st.agentRunning;
  st.agentRunning = false;
  st.nextRunAt = null;
  if (st.agentConvId) stop(st.agentConvId);
  emit();
  if (wasRunning) toast('info', tl('AI agent stopped'));
}

/** Kill switch: stops the agent and every AI request, cancels the agent's working orders. */
export function killSwitch(): void {
  guard.kill();
  stopAgent();
  for (const id of Object.keys(st.busy)) stop(id);
  rejectOrders();
  let n = 0;
  for (const o of paper.workingOrders()) if (o.tag === 'ai-agent' && paper.cancel(o.id)) n++;
  audit({
    mode: 'agent',
    conversationId: st.agentConvId ?? '',
    tool: 'kill_switch',
    args: '{}',
    ok: true,
    summary: `Kill switch: agent stopped, ${n} agent orders cancelled`,
  });
  emit(true);
  toast(
    'error',
    tl('AI kill switch'),
    tt`Agent stopped and blocked; ${n} agent orders cancelled`,
    8000,
  );
}
