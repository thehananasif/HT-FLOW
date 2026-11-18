/**
 * AI providers (bring your own key). Keys never live here: they are written once to the encrypted
 * vault (`ai/<configId>/key`) and read only by the native core when it makes a call.
 */
export type ProviderKind =
  | 'xai'
  | 'anthropic'
  | 'gemini'
  | 'openai'
  | 'mistral'
  | 'deepseek'
  | 'qwen'
  | 'custom'
  | 'ollama'
  | 'lmstudio';

export interface ProviderInfo {
  kind: ProviderKind;
  label: string;
  /** Default base URL ('' = the user must enter one). */
  baseUrl: string;
  needsKey: boolean;
  /** Models offered before the live list is fetched (editable). */
  models: string[];
  /** Models whose id matches read images (screenshots). */
  vision: (model: string) => boolean;
  keyHint: string;
  local?: boolean;
}

const yes = () => true;

export const PROVIDERS: ProviderInfo[] = [
  {
    kind: 'anthropic',
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    vision: yes,
    keyHint: 'sk-ant-…',
  },
  {
    kind: 'openai',
    label: 'OpenAI ChatGPT',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'],
    vision: yes,
    keyHint: 'sk-…',
  },
  {
    kind: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: true,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    vision: yes,
    keyHint: 'AIza…',
  },
  {
    kind: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    models: ['grok-4', 'grok-3-mini'],
    vision: (m) => !/mini/.test(m),
    keyHint: 'xai-…',
  },
  {
    kind: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    models: ['mistral-large-latest', 'mistral-medium-latest', 'pixtral-large-latest'],
    vision: (m) => /pixtral|medium|small/.test(m),
    keyHint: 'API key',
  },
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    vision: () => false,
    keyHint: 'sk-…',
  },
  {
    kind: 'qwen',
    label: 'Qwen (Alibaba DashScope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    models: ['qwen-max', 'qwen-plus', 'qwen-vl-max'],
    vision: (m) => /vl|omni/.test(m),
    keyHint: 'sk-…',
  },
  {
    kind: 'custom',
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    needsKey: false,
    models: [],
    vision: yes,
    keyHint: 'Optional',
  },
  {
    kind: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    models: ['llama3.2-vision', 'qwen2.5'],
    vision: (m) => /vision|llava|vl|gemma3/.test(m),
    keyHint: 'Not needed',
    local: true,
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    models: [],
    vision: (m) => /vision|llava|vl|gemma3/.test(m),
    keyHint: 'Not needed',
    local: true,
  },
];

export function providerInfo(kind: ProviderKind): ProviderInfo {
  return PROVIDERS.find((p) => p.kind === kind) ?? PROVIDERS[0]!;
}

/** One configured provider (a user may add several custom endpoints). */
export interface ProviderConfig {
  /** `[a-z0-9-]{1,48}`, also the vault scope. */
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  /** Set after a key was saved (the key itself is never stored here). */
  hasKey: boolean;
}

export const CONFIG_ID = /^[a-z0-9-]{1,48}$/;

export const keyVaultName = (configId: string) => `ai/${configId}/key`;

export function defaultConfigs(): ProviderConfig[] {
  return PROVIDERS.filter((p) => p.kind !== 'custom').map((p) => ({
    id: p.kind,
    kind: p.kind,
    label: p.label,
    baseUrl: p.baseUrl,
    models: [...p.models],
    defaultModel: p.models[0] ?? '',
    hasKey: false,
  }));
}

const isLoopbackHost = (h: string) =>
  h === 'localhost' ||
  h.endsWith('.localhost') ||
  /^127\.\d+\.\d+\.\d+$/.test(h) ||
  h === '[::1]' ||
  h === '::1';

/**
 * Mirrors the native allow-list (crates/ai/src/provider.rs) so the form can explain problems
 * before anything is sent. The native check is the one that is enforced.
 */
export function checkBaseUrl(kind: ProviderKind, raw: string): string | null {
  const info = providerInfo(kind);
  const s = raw.trim() || info.baseUrl;
  if (!s) return 'Enter the endpoint base URL';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'Not a valid URL';
  }
  if (u.username || u.password) return 'URLs with a user name or password are not allowed';
  if (u.search || u.hash) return 'The base URL may not have a query or fragment';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http(s) URLs are allowed';
  const host = u.hostname.toLowerCase();
  const loop = isLoopbackHost(host);
  if (info.local) return loop ? null : 'Local models must run on this PC (localhost)';
  if (kind === 'custom') {
    if (loop) return null;
    if (u.protocol !== 'https:') return 'Remote endpoints must use https://';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host))
      return 'Private network addresses are not allowed';
    return null;
  }
  const allowed = new URL(info.baseUrl).hostname;
  const qwenAlt = kind === 'qwen' && host === 'dashscope.aliyuncs.com';
  if (u.protocol !== 'https:' || (host !== allowed && !qwenAlt) || (u.port && u.port !== '443'))
    return `Only https://${allowed} is allowed for ${info.label}`;
  return null;
}

/** Repairs configs loaded from settings (unknown kinds dropped, defaults added back). */
export function sanitizeConfigs(raw: unknown): ProviderConfig[] {
  const defaults = defaultConfigs();
  if (!Array.isArray(raw)) return defaults;
  const out: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const r of raw as Partial<ProviderConfig>[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !CONFIG_ID.test(r.id)) continue;
    if (!PROVIDERS.some((p) => p.kind === r.kind) || seen.has(r.id)) continue;
    const info = providerInfo(r.kind!);
    const models = Array.isArray(r.models)
      ? r.models.filter((m): m is string => typeof m === 'string' && m.length > 0).slice(0, 500)
      : [...info.models];
    seen.add(r.id);
    out.push({
      id: r.id,
      kind: r.kind!,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.slice(0, 60) : info.label,
      baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl.slice(0, 300) : info.baseUrl,
      models,
      defaultModel:
        typeof r.defaultModel === 'string' && r.defaultModel ? r.defaultModel : (models[0] ?? ''),
      hasKey: r.hasKey === true,
    });
  }
  for (const d of defaults) if (!seen.has(d.id)) out.push(d);
  return out;
}

/** A free config id: the provider kind itself, else `<kind>-<n>`. */
export function newCustomId(
  existing: readonly ProviderConfig[],
  kind: ProviderKind = 'custom',
): string {
  if (kind !== 'custom' && !existing.some((c) => c.id === kind)) return kind;
  let n = kind === 'custom' ? 1 : 2;
  while (existing.some((c) => c.id === `${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

export type ProviderStatus = 'ok' | 'untested' | 'failed' | 'nokey';

/** Chip colour source: green = key saved (or none needed) and reachable on the last test. */
export function providerStatus(
  c: Pick<ProviderConfig, 'kind' | 'hasKey'>,
  health: { ok: boolean } | undefined,
): ProviderStatus {
  if (providerInfo(c.kind).needsKey && !c.hasKey) return 'nokey';
  if (!health) return 'untested';
  return health.ok ? 'ok' : 'failed';
}
