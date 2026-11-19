import { useState, useSyncExternalStore } from 'react';
import {
  Bot,
  Brain,
  Cloud,
  Cpu,
  Gem,
  Plug,
  Search,
  Server,
  Sparkles,
  Wind,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Badge, Button, Combobox, Input, Select, toast } from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
import { aiNative, errorText } from './native';
import {
  checkBaseUrl,
  newCustomId,
  PROVIDERS,
  providerInfo,
  providerStatus,
  type ProviderConfig,
  type ProviderKind,
} from './providers';
import { ai, fetchModels, saveKey, setConfigs, testConnection, updateConfig } from './runtime';

/** Generic, logo-free marks per provider kind. */
const ICONS: Record<ProviderKind, LucideIcon> = {
  anthropic: Sparkles,
  openai: Bot,
  gemini: Gem,
  xai: Zap,
  mistral: Wind,
  deepseek: Search,
  qwen: Cloud,
  custom: Plug,
  ollama: Server,
  lmstudio: Cpu,
};

function ProviderCard({ c }: { c: ProviderConfig }) {
  const info = providerInfo(c.kind);
  const st = ai.state();
  const health = st.health[c.id];
  const status = providerStatus(c, health);
  const [key, setKey] = useState('');
  const [base, setBase] = useState(c.baseUrl);
  const [models, setModels] = useState(c.models.join('\n'));
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const urlErr = checkBaseUrl(c.kind, base);
  const Icon = ICONS[c.kind] ?? Brain;
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
  const test = async () => {
    setTesting(true);
    const h = await testConnection(c.id);
    setTesting(false);
    if (h.models)
      setModels(
        ai
          .state()
          .configs.find((x) => x.id === c.id)
          ?.models.join('\n') ?? '',
      );
    toast(
      h.ok ? 'success' : 'error',
      h.ok ? t('ai.test.ok', { ms: h.ms }) : t('ai.test.failed'),
      h.ok ? c.label : h.error,
    );
  };
  return (
    <div className="ai-provider" data-testid={`ai-provider-${c.id}`} data-status={status}>
      <div className="ai-provider-head">
        <span className="ai-provider-icon" aria-hidden>
          <Icon size={16} />
        </span>
        <strong>{c.label}</strong>
        {info.local && <Badge>{t('ai.local')}</Badge>}
        {c.hasKey ? (
          <Badge kind="live">{t('ai.keySaved')}</Badge>
        ) : info.needsKey ? (
          <Badge kind="error">{t('ai.noKey')}</Badge>
        ) : null}
        <span className="grow" />
        <span className="ai-status-chip" data-state={status} data-testid={`ai-status-${c.id}`}>
          <span className="ai-dot" data-state={status} aria-hidden />
          {status === 'ok'
            ? t('ai.status.ok')
            : status === 'failed'
              ? t('ai.status.failed')
              : status === 'nokey'
                ? t('ai.status.nokey')
                : t('ai.status.untested')}
        </span>
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
        <div className="ai-wide ai-test">
          <Button
            size="sm"
            variant="outline"
            disabled={testing || !!urlErr}
            onClick={() => void test()}
            data-testid={`ai-test-${c.id}`}
          >
            {testing ? t('ai.testing') : t('ai.testConnection')}
          </Button>
          {health && (
            <span
              className={`tnum ai-test-result ${health.ok ? 'is-ok' : 'is-fail'}`}
              data-testid={`ai-latency-${c.id}`}
              dir="ltr"
            >
              {health.ok
                ? t('ai.test.result', { ms: health.ms, n: health.models ?? 0 })
                : (health.error ?? t('ai.test.failed'))}
            </span>
          )}
          {aiNative.kind === 'none' && <span className="ai-hint">{t('ai.noBrowser')}</span>}
        </div>
        <label className="ai-wide">
          {t('ai.defaultModel')}
          <Combobox
            aria-label={t('ai.modelOf', { label: c.label })}
            value={c.defaultModel}
            allowCustom
            placeholder={t('ai.searchModels')}
            options={c.models.map((m) => ({ value: m, label: m }))}
            onChange={(v) => updateConfig(c.id, { defaultModel: v })}
          />
        </label>
        <details className="ai-wide">
          <summary>{t('ai.modelsLabel')}</summary>
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
          <div className="row">
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void fetchList()}>
              {loading ? t('ai.loading') : t('ai.fetchModels')}
            </Button>
          </div>
        </details>
      </div>
    </div>
  );
}

export function ProvidersTab() {
  useSyncExternalStore(ai.subscribe, ai.version);
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
      <div className="ai-provider-grid">
        {st.configs.map((c) => (
          <ProviderCard key={c.id} c={c} />
        ))}
      </div>
    </div>
  );
}
