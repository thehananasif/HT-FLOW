import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../backend';
import type { ProviderKind } from './providers';

/** Neutral chat format (crates/ai `ChatRequest`). */
export type AiPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown; signature?: string }
  | { type: 'toolResult'; id: string; name: string; content: string; isError: boolean };

export interface AiMessage {
  role: 'user' | 'assistant';
  parts: AiPart[];
}

export interface AiToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiChatRequest {
  provider: ProviderKind;
  model: string;
  system?: string;
  messages: AiMessage[];
  tools?: AiToolDef[];
  maxTokens?: number;
  temperature?: number;
}

export type AiEvent =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; id: string; name: string; arguments: unknown; signature?: string }
  | { kind: 'usage'; input: number; output: number }
  | { kind: 'done'; stopReason: string }
  | { kind: 'error'; code: string; message: string };

export interface ChatTarget {
  configId: string;
  baseUrl?: string;
}

export interface AiNative {
  readonly kind: 'tauri' | 'mock' | 'none';
  chat(
    requestId: string,
    target: ChatTarget,
    req: AiChatRequest,
    onEvent: (e: AiEvent) => void,
  ): Promise<void>;
  cancel(requestId: string): Promise<boolean>;
  listModels(provider: ProviderKind, target: ChatTarget): Promise<string[]>;
  keyStatus(configId: string): Promise<boolean>;
}

export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String(e.message);
  return String(e);
}

const tauriNative: AiNative = {
  kind: 'tauri',
  chat: (requestId, target, request, onEvent) => {
    const channel = new Channel<AiEvent>();
    channel.onmessage = onEvent;
    return invoke('ai_chat', {
      requestId,
      configId: target.configId,
      baseUrl: target.baseUrl || null,
      request: { tools: [], ...request },
      channel,
    });
  },
  cancel: (requestId) => invoke('ai_cancel', { requestId }),
  listModels: (provider, target) =>
    invoke('ai_list_models', {
      provider,
      configId: target.configId,
      baseUrl: target.baseUrl || null,
    }),
  keyStatus: (configId) => invoke('ai_key_status', { configId }),
};

const unavailable = (): Promise<never> =>
  Promise.reject({
    code: 'ai.desktop_only',
    message:
      'AI calls need the HT Flow desktop app (the browser preview cannot reach AI providers).',
  });

const noneNative: AiNative = {
  kind: 'none',
  chat: unavailable,
  cancel: async () => false,
  listModels: unavailable,
  keyStatus: async () => false,
};

/** Scripted reply for the web build's e2e tests (`window.__HTFLOW_AI_MOCK__`). */
export interface MockScript {
  /** Text streamed back; `{context}` is replaced by whether a context block was sent. */
  reply?: string;
  /** Tool calls returned on the first turn when tools are offered. */
  toolCalls?: { name: string; arguments: unknown }[];
  /** Delay between tokens (ms). */
  tokenMs?: number;
}

export interface MockLog {
  requests: AiChatRequest[];
}

/**
 * In-memory "provider" that streams like the native side does: tokens, tool calls on the first
 * turn of an agent run, usage, done. Records each request so tests can inspect what was sent.
 */
export function createMockNative(script: MockScript = {}, log: MockLog = { requests: [] }) {
  const running = new Map<string, { stop: boolean }>();
  const native: AiNative = {
    kind: 'mock',
    async chat(requestId, _target, req, onEvent) {
      log.requests.push(JSON.parse(JSON.stringify(req)) as AiChatRequest);
      const flag = { stop: false };
      running.set(requestId, flag);
      const last = req.messages[req.messages.length - 1];
      const answeredTools = last?.parts.some((p) => p.type === 'toolResult');
      const hasImage = req.messages.some((m) => m.parts.some((p) => p.type === 'image'));
      if (req.tools?.length && script.toolCalls?.length && !answeredTools) {
        let n = 0;
        for (const c of script.toolCalls)
          onEvent({
            kind: 'toolCall',
            id: `mock-call-${++n}`,
            name: c.name,
            arguments: c.arguments,
          });
        onEvent({ kind: 'done', stopReason: 'tool_use' });
        running.delete(requestId);
        return;
      }
      const text = answeredTools
        ? 'Done. Tool results received.'
        : (script.reply ?? 'Mock analysis: order flow is balanced.') +
          (hasImage ? ' [screenshot received]' : '');
      for (const tok of text.match(/\S+\s*/g) ?? []) {
        if (flag.stop) {
          onEvent({ kind: 'done', stopReason: 'cancelled' });
          running.delete(requestId);
          return;
        }
        onEvent({ kind: 'text', text: tok });
        await new Promise((r) => setTimeout(r, script.tokenMs ?? 15));
      }
      onEvent({ kind: 'usage', input: 100, output: 20 });
      onEvent({ kind: 'done', stopReason: 'end_turn' });
      running.delete(requestId);
    },
    async cancel(requestId) {
      const f = running.get(requestId);
      if (f) f.stop = true;
      return !!f;
    },
    async listModels() {
      return ['mock-large', 'mock-small'];
    },
    async keyStatus() {
      return true;
    },
  };
  return native;
}

declare global {
  interface Window {
    __HTFLOW_AI_MOCK__?: boolean | MockScript;
    __HTFLOW_AI_LOG__?: MockLog;
  }
}

function pick(): AiNative {
  if (isTauri) return tauriNative;
  const m = typeof window !== 'undefined' ? window.__HTFLOW_AI_MOCK__ : undefined;
  if (m) {
    const log: MockLog = { requests: [] };
    window.__HTFLOW_AI_LOG__ = log;
    return createMockNative(typeof m === 'object' ? m : {}, log);
  }
  return noneNative;
}

export const aiNative: AiNative = pick();
