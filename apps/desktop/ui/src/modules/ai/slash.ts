/**
 * Slash commands and quick actions of the AI composer. Pure parsing: the UI resolves the prompt
 * text through i18n (`ai.prompt.<id>`) so requests follow the user's language.
 */
export type SlashId = 'analyse' | 'levels' | 'risk' | 'screenshot' | 'footprint' | 'flow';

export interface SlashDef {
  id: SlashId;
  /** Typed name without the slash, plus accepted aliases. */
  name: string;
  aliases: string[];
  /** Attach a screenshot (when the setting and the model allow it); the context is always sent. */
  screenshot: boolean;
}

export const SLASH: readonly SlashDef[] = [
  { id: 'analyse', name: 'analyse', aliases: ['analyze', 'chart'], screenshot: true },
  { id: 'levels', name: 'levels', aliases: ['level'], screenshot: false },
  { id: 'risk', name: 'risk', aliases: [], screenshot: false },
  { id: 'screenshot', name: 'screenshot', aliases: ['shot', 'screen'], screenshot: true },
  { id: 'footprint', name: 'footprint', aliases: ['fp'], screenshot: false },
  { id: 'flow', name: 'flow', aliases: ['orderflow'], screenshot: false },
];

export interface ParsedSlash {
  def: SlashDef;
  /** Text after the command (extra instructions); may be empty. */
  rest: string;
}

const find = (name: string): SlashDef | undefined => {
  const n = name.toLowerCase();
  return SLASH.find((s) => s.name === n || s.aliases.includes(n));
};

/** `/analyse focus on delta` → command + rest; anything else (or an unknown command) → null. */
export function parseSlash(input: string): ParsedSlash | null {
  const m = input.trim().match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const def = find(m[1]!);
  return def ? { def, rest: (m[2] ?? '').trim() } : null;
}

/** Commands to offer while the user is still typing the command word. */
export function suggestSlash(input: string): SlashDef[] {
  const m = input.match(/^\/([a-zA-Z]*)$/);
  if (!m) return [];
  const q = m[1]!.toLowerCase();
  return SLASH.filter((s) => s.name.startsWith(q) || s.aliases.some((a) => a.startsWith(q)));
}

export interface QuickAction {
  id: 'analyse' | 'footprint' | 'flow15' | 'risk' | 'levels';
  slash: SlashId;
  screenshot: boolean;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: 'analyse', slash: 'analyse', screenshot: true },
  { id: 'footprint', slash: 'footprint', screenshot: false },
  { id: 'flow15', slash: 'flow', screenshot: false },
  { id: 'risk', slash: 'risk', screenshot: false },
  { id: 'levels', slash: 'levels', screenshot: false },
];
