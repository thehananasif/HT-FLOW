/**
 * Tiny action bus between the Command Palette and the AI window: an action is handled by the
 * mounted window, or kept until it mounts (the palette opens the window first).
 */
import type { QuickAction } from './slash';

export type AiTab = 'chat' | 'agent' | 'audit' | 'providers';

export type AiAction =
  | { type: 'quick'; id: QuickAction['id'] }
  | { type: 'fill'; text: string; shot?: boolean }
  | { type: 'stop' }
  | { type: 'editLast' }
  | { type: 'regenerate' }
  | { type: 'focus' }
  | { type: 'tab'; tab: AiTab };

type Handler = (a: AiAction) => boolean;

const handlers = new Set<Handler>();
let queue: AiAction[] = [];

export function dispatchAi(a: AiAction): void {
  for (const h of handlers) if (h(a)) return;
  queue.push(a);
}

/** Registers a handler (return true when the action was taken) and replays waiting actions. */
export function onAi(h: Handler): () => void {
  handlers.add(h);
  const waiting = queue;
  queue = [];
  for (const a of waiting) if (!h(a)) queue.push(a);
  return () => void handlers.delete(h);
}
