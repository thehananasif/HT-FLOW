/**
 * Conversations and the turn loop (pure: the native bridge and tool runner are injected).
 */
import type { AiEvent, AiMessage, AiNative, AiPart, AiToolDef, ChatTarget } from './native';
import type { ProviderKind } from './providers';
import type { ToolOutcome } from './tools';

export interface ToolCallRec {
  id: string;
  name: string;
  arguments: unknown;
  signature?: string;
}
export interface ToolResultRec {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** Screenshot sent with this message (kept in memory only, never saved). */
  image?: { mediaType: 'image/png' | 'image/jpeg'; data: string };
  /** True once a screenshot was sent (survives saving without the pixels). */
  hadImage?: boolean;
  /** Structured screen context sent with this message (shown collapsed). */
  context?: string;
  toolCalls?: ToolCallRec[];
  toolResults?: ToolResultRec[];
  error?: string;
  stopReason?: string;
  usage?: { input: number; output: number };
  pending?: boolean;
  ts: number;
}

export interface Conversation {
  id: string;
  title: string;
  configId: string;
  provider: ProviderKind;
  model: string;
  presetId: string;
  /** Custom system prompt (used when presetId is 'custom'). */
  system: string;
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
}

export interface Preset {
  id: string;
  label: string;
  prompt: string;
}

const SAFETY =
  'You are inside HT Flow, a desktop order-flow trading platform. Be precise with numbers and say when data is missing. Never claim an order was placed unless a tool result confirms it. Not financial advice.';

export const PRESETS: Preset[] = [
  {
    id: 'analyst',
    label: 'Market analyst',
    prompt: `${SAFETY} Act as a concise market analyst: structure, key levels, order-flow evidence (delta, absorption, large prints), scenarios with invalidation levels.`,
  },
  {
    id: 'risk',
    label: 'Risk coach',
    prompt: `${SAFETY} Act as a risk coach: review positions, size, stops and daily P&L against the trader's limits; flag overtrading and revenge trading; suggest concrete risk reductions.`,
  },
  {
    id: 'orderflow',
    label: 'Order-flow explainer',
    prompt: `${SAFETY} Explain order-flow concepts (footprint, delta, imbalances, DOM liquidity, tape) in plain words using what is on the trader's screen as the example.`,
  },
  {
    id: 'agent',
    label: 'Trading agent',
    prompt: `${SAFETY} You are an automated trading agent. Use the tools to read market data, order flow, positions and the account before acting. Only trade when your rules are clearly met, keep size within the limits, always use a stop-loss, and explain each decision in one or two sentences. If unsure, do nothing.`,
  },
  { id: 'custom', label: 'Custom…', prompt: '' },
];

export function systemPrompt(c: Pick<Conversation, 'presetId' | 'system'>): string {
  if (c.presetId === 'custom') return c.system.trim() || SAFETY;
  return PRESETS.find((p) => p.id === c.presetId)?.prompt ?? PRESETS[0]!.prompt;
}

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** Wire messages for the provider. Tool messages become user messages with tool results. */
export function toWire(msgs: readonly ChatMsg[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of msgs) {
    if (m.pending && !m.text && !m.toolCalls?.length) continue;
    const parts: AiPart[] = [];
    if (m.role === 'tool') {
      for (const r of m.toolResults ?? [])
        parts.push({ type: 'toolResult', id: r.id, name: r.name, content: r.content, isError: r.isError });
      if (parts.length) out.push({ role: 'user', parts });
      continue;
    }
    if (m.role === 'user') {
      const text = m.context ? `${m.text}\n\n<screen_context>\n${m.context}\n</screen_context>` : m.text;
      if (text) parts.push({ type: 'text', text });
      if (m.image) parts.push({ type: 'image', mediaType: m.image.mediaType, data: m.image.data });
      else if (m.hadImage) parts.push({ type: 'text', text: '[earlier screenshot not resent]' });
    } else {
      if (m.text) parts.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? [])
        parts.push({
          type: 'toolCall',
          id: c.id,
          name: c.name,
          arguments: c.arguments,
          ...(c.signature ? { signature: c.signature } : {}),
        });
    }
    if (!parts.length) continue;
    // Providers want alternating roles: merge consecutive same-role messages.
    const prev = out[out.length - 1];
    if (prev && prev.role === (m.role === 'user' ? 'user' : 'assistant')) prev.parts.push(...parts);
    else out.push({ role: m.role === 'user' ? 'user' : 'assistant', parts });
  }
  return out;
}

export interface TurnDeps {
  native: AiNative;
  target: ChatTarget;
  tools: AiToolDef[];
  runTool(name: string, args: unknown): Promise<ToolOutcome>;
  /** Called after every change (streamed token, tool result). */
  onChange(): void;
  /** Max model calls in this turn (tool round trips). */
  maxSteps: number;
  maxTokens?: number;
  /** Set to stop between steps; the running request is cancelled too. */
  signal: { stopped: boolean; requestId?: string };
}

/**
 * Runs one user turn: model call → (tool calls → results → model call)* until the model stops
 * calling tools, the step limit is reached or the user stops it. Mutates `conv.messages`.
 */
export async function runTurn(conv: Conversation, d: TurnDeps): Promise<void> {
  for (let step = 0; step < d.maxSteps; step++) {
    if (d.signal.stopped) return;
    const msg: ChatMsg = { id: uid('m'), role: 'assistant', text: '', pending: true, ts: Date.now() };
    const request = {
      provider: conv.provider,
      model: conv.model,
      system: systemPrompt(conv),
      messages: toWire(conv.messages),
      tools: d.tools,
      ...(d.maxTokens ? { maxTokens: d.maxTokens } : {}),
    };
    conv.messages.push(msg);
    d.onChange();
    const requestId = uid('req');
    d.signal.requestId = requestId;
    const calls: ToolCallRec[] = [];
    const onEvent = (e: AiEvent) => {
      if (e.kind === 'text') msg.text += e.text;
      else if (e.kind === 'toolCall')
        calls.push({ id: e.id, name: e.name, arguments: e.arguments, ...(e.signature ? { signature: e.signature } : {}) });
      else if (e.kind === 'usage') msg.usage = { input: e.input, output: e.output };
      else if (e.kind === 'done') msg.stopReason = e.stopReason;
      else if (e.kind === 'error') msg.error = e.message;
      d.onChange();
    };
    try {
      await d.native.chat(requestId, d.target, request, onEvent);
    } catch (e) {
      msg.error ??= e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    }
    msg.pending = false;
    if (calls.length) msg.toolCalls = calls;
    conv.updatedAt = Date.now();
    d.onChange();
    if (msg.error || msg.stopReason === 'cancelled' || d.signal.stopped || !calls.length) return;
    const results: ToolResultRec[] = [];
    const tool: ChatMsg = { id: uid('m'), role: 'tool', text: '', toolResults: results, ts: Date.now() };
    conv.messages.push(tool);
    for (const c of calls) {
      let out: ToolOutcome;
      if (!d.tools.some((t) => t.name === c.name))
        out = { ok: false, result: { error: `Tool ${c.name} is not available` }, summary: 'not available' };
      else if (d.signal.stopped) out = { ok: false, result: { error: 'Stopped by the user' }, summary: 'stopped' };
      else {
        try {
          out = await d.runTool(c.name, c.arguments);
        } catch (e) {
          out = { ok: false, result: { error: String(e) }, summary: String(e) };
        }
      }
      results.push({ id: c.id, name: c.name, content: JSON.stringify(out.result), isError: !out.ok });
      tool.text += `${out.ok ? '✓' : '✗'} ${c.name}: ${out.summary}\n`;
      d.onChange();
    }
  }
  if (!d.signal.stopped) {
    conv.messages.push({
      id: uid('m'),
      role: 'assistant',
      text: '',
      error: `Stopped after ${d.maxSteps} steps (agent step limit).`,
      ts: Date.now(),
    });
    d.onChange();
  }
}

/** Title from the first user message. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t || 'New chat';
}

/** Saved form: no image pixels, no pending flags, bounded size. */
export function forSave(convs: readonly Conversation[]): Conversation[] {
  return convs.slice(0, 100).map((c) => ({
    ...c,
    messages: c.messages.slice(-300).map((m) => {
      const { image, pending: _p, ...rest } = m;
      return image ? { ...rest, hadImage: true } : rest;
    }),
  }));
}

export function sanitizeConversations(raw: unknown): Conversation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is Conversation =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as Conversation).id === 'string' &&
      Array.isArray((c as Conversation).messages) &&
      typeof (c as Conversation).configId === 'string',
  );
}

/** Text of the assistant reply that a "regenerate" replaces: drops everything after the last user message. */
export function truncateToLastUser(conv: Conversation): boolean {
  let i = conv.messages.length - 1;
  while (i >= 0 && conv.messages[i]!.role !== 'user') i--;
  if (i < 0) return false;
  conv.messages.splice(i + 1);
  return true;
}
