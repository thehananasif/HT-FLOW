import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Badge, Button, Checkbox, Dialog, Field, Input, NumberInput, Select } from '@htflow/ui-kit';
import { backend, isTauri } from '../../backend';
import { paper } from '../../state/market';
import { setVenueEnabled } from '../../state/liveFeed';
import { useConnections } from './store';
import {
  isAvailable,
  providerById,
  searchProviders,
  validateConnection,
  type ConnectionConfig,
  type Provider,
} from './providers';

const DEFAULT_SYMBOL: Record<string, string> = {
  'binance-futures': 'BTCUSDT',
  'bybit-linear': 'BTCUSDT',
};

function blank(p: Provider): ConnectionConfig {
  return {
    id: `${p.id}-${Date.now().toString(36)}`,
    provider: p.id,
    name: p.name,
    environment: p.form === 'simulator' ? 'demo' : 'live',
    server: '',
    username: '',
    gatewayHost: p.gateway ? '127.0.0.1' : undefined,
    gatewayPort: p.gateway ? (p.id.startsWith('mt5') ? 443 : 7497) : undefined,
    startingBalance: p.form === 'simulator' ? 50_000 : undefined,
    marketData: true,
    trading: p.form !== 'crypto',
    record: p.form === 'crypto',
    connectOnStart: p.form !== 'broker',
  };
}

/** Add / edit connection (P32): step 1 provider tree, step 2 provider form. */
export function ConnectionWizard({
  open,
  onClose,
  edit,
}: {
  open: boolean;
  onClose: () => void;
  edit?: ConnectionConfig;
}) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<Provider | null>(
    edit ? (providerById(edit.provider) ?? null) : null,
  );
  const [form, setForm] = useState<ConnectionConfig | null>(edit ?? null);
  const [secret, setSecret] = useState({ apiKey: '', apiSecret: '', password: '' });
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => searchProviders(query), [query]);
  const errors = provider && form ? validateConnection(provider, form) : {};
  const upsert = useConnections((s) => s.upsert);

  const pick = (p: Provider) => {
    setProvider(p);
    setForm(edit && edit.provider === p.id ? edit : blank(p));
    setTest(null);
  };
  const patch = (p: Partial<ConnectionConfig>) => setForm((f) => (f ? { ...f, ...p } : f));

  const runTest = async () => {
    if (!provider) return;
    if (!isAvailable(provider)) {
      setTest({ ok: false, text: `Coming soon — ${provider.blocked}` });
      return;
    }
    if (provider.simulator) {
      setTest({ ok: true, text: 'Built-in simulator is ready' });
      return;
    }
    if (!isTauri) {
      setTest({ ok: false, text: 'Live connectors run in the desktop app only' });
      return;
    }
    setBusy(true);
    try {
      const r = await invoke<{ ok: boolean; latencyMs: number; message: string }>('market_test', {
        venue: provider.venue,
        symbol: DEFAULT_SYMBOL[provider.venue ?? ''] ?? 'BTCUSDT',
      });
      setTest({
        ok: r.ok,
        text: r.ok ? `OK · ${r.latencyMs.toFixed(0)} ms · ${r.message}` : `Error: ${r.message}`,
      });
    } catch (e) {
      setTest({ ok: false, text: `Error: ${String((e as { message?: string }).message ?? e)}` });
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!provider || !form || Object.keys(errors).length) return;
    setBusy(true);
    try {
      const keys: [string, string][] = [];
      if (secret.apiKey) keys.push(['apiKey', secret.apiKey]);
      if (secret.apiSecret) keys.push(['apiSecret', secret.apiSecret]);
      if (secret.password) keys.push(['password', secret.password]);
      // Credentials go to the encrypted vault (P03), never into settings.
      for (const [k, v] of keys) await backend.vaultPut(`connections.${form.id}.${k}`, v);
      const saved = { ...form, hasSecret: form.hasSecret || keys.length > 0 };
      upsert(saved);
      if (provider.venue) setVenueEnabled(provider.venue, true);
      if (provider.simulator && saved.trading) {
        try {
          paper.createAccount({
            id: `paper-${saved.id}`,
            name: `${saved.name} · Paper`,
            startingBalance: saved.startingBalance ?? 50_000,
            commissionPerUnit: 0,
          });
        } catch {
          // Account already exists (edit).
        }
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const err = (k: string) => (form ? errors[k] : undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`${edit ? 'Edit connection' : 'Add connection'} · Step ${provider ? 2 : 1} of 2`}
      width={880}
    >
      <div className="cx-wizard">
        <div className="cx-tree">
          <Input
            placeholder="Search providers…"
            aria-label="Search providers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="cx-tree-list">
            {groups.map((g) => (
              <div key={g.group}>
                <div className="cx-group">▾ {g.group}</div>
                {g.items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="cx-prov"
                    data-active={provider?.id === p.id || undefined}
                    onClick={() => pick(p)}
                  >
                    <span>{p.name}</span>
                    <span className="cx-tag">{p.tag}</span>
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <div className="muted pad12">No provider matches “{query}”</div>}
          </div>
        </div>
        <div className="cx-form">
          {!provider || !form ? (
            <div className="muted pad12">
              Pick a provider on the left. FREE = public data or built-in; YOUR ACCOUNT = needs your
              own login / licence.
            </div>
          ) : (
            <>
              <div className="cx-head">
                <div className="cx-avatar">{provider.name[0]}</div>
                <div>
                  <h3>{provider.name}</h3>
                  <p className="muted">{provider.blurb}</p>
                </div>
              </div>
              <div className="cx-chips">
                <Badge kind={provider.tag === 'FREE' ? 'free' : 'default'}>{provider.tag}</Badge>
                {provider.caps.map((c) => (
                  <span key={c} className="cx-chip">
                    {c}
                  </span>
                ))}
              </div>
              {provider.blocked && (
                <div className="cx-note cx-note--warn">
                  Coming soon / requires SDK — {provider.blocked}. You can save the connection now;
                  it will show as unavailable until the connector ships.
                </div>
              )}
              <Field label="Connection name" error={err('name')}>
                <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} />
              </Field>
              {provider.form === 'crypto' && (
                <>
                  <Field label="API key (optional — only for trading)">
                    <Input
                      value={secret.apiKey}
                      autoComplete="off"
                      placeholder={form.hasSecret ? 'Stored in vault — leave empty to keep' : ''}
                      onChange={(e) => setSecret({ ...secret, apiKey: e.target.value })}
                    />
                  </Field>
                  <Field label="API secret (optional)">
                    <Input
                      type="password"
                      value={secret.apiSecret}
                      autoComplete="off"
                      onChange={(e) => setSecret({ ...secret, apiSecret: e.target.value })}
                    />
                  </Field>
                  <Field label="Environment">
                    <Select
                      aria-label="Environment"
                      value={form.environment}
                      options={[
                        { value: 'live', label: 'Live (mainnet)' },
                        { value: 'testnet', label: 'Testnet' },
                      ]}
                      onChange={(v) => patch({ environment: v })}
                    />
                  </Field>
                </>
              )}
              {provider.form === 'broker' && (
                <>
                  <Field label="Server / system" error={err('server')}>
                    <Input
                      value={form.server ?? ''}
                      placeholder="e.g. Paper Trading · Chicago"
                      onChange={(e) => patch({ server: e.target.value })}
                    />
                  </Field>
                  <Field label="Username" error={err('username')}>
                    <Input
                      value={form.username ?? ''}
                      autoComplete="off"
                      onChange={(e) => patch({ username: e.target.value })}
                    />
                  </Field>
                  <Field label="Password">
                    <Input
                      type="password"
                      value={secret.password}
                      autoComplete="off"
                      placeholder={form.hasSecret ? 'Stored in vault — leave empty to keep' : ''}
                      onChange={(e) => setSecret({ ...secret, password: e.target.value })}
                    />
                  </Field>
                  {provider.gateway && (
                    <div className="row gap8">
                      <Field label="Gateway host" error={err('gatewayHost')}>
                        <Input
                          value={form.gatewayHost ?? ''}
                          onChange={(e) => patch({ gatewayHost: e.target.value })}
                        />
                      </Field>
                      <Field label="Port" error={err('gatewayPort')}>
                        <NumberInput
                          aria-label="Gateway port"
                          value={form.gatewayPort ?? 0}
                          min={1}
                          max={65_535}
                          onChange={(v) => patch({ gatewayPort: v })}
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}
              {provider.form === 'simulator' && (
                <Field label="Starting balance (USD)" error={err('startingBalance')}>
                  <NumberInput
                    aria-label="Starting balance"
                    value={form.startingBalance ?? 50_000}
                    step={1000}
                    min={100}
                    max={100_000_000}
                    onChange={(v) => patch({ startingBalance: v })}
                  />
                </Field>
              )}
              <div className="cx-options">
                <Checkbox
                  label="Use for market data"
                  checked={form.marketData}
                  onChange={(v) => patch({ marketData: v })}
                />
                <Checkbox
                  label="Use for trading (orders go to this connection)"
                  checked={form.trading}
                  onChange={(v) => patch({ trading: v })}
                />
                <Checkbox
                  label="Record ticks + depth to local history"
                  checked={form.record}
                  onChange={(v) => patch({ record: v })}
                />
                <Checkbox
                  label="Connect automatically on start"
                  checked={form.connectOnStart}
                  onChange={(v) => patch({ connectOnStart: v })}
                />
                {err('options') && <span className="ht-error">{err('options')}</span>}
              </div>
              <div className="cx-note">
                Credentials are stored in your encrypted vault on this PC. They are never sent
                anywhere except to {provider.name}.
              </div>
              {test && (
                <div className={`cx-test ${test.ok ? 'ok' : 'bad'}`} role="status">
                  {test.text}
                </div>
              )}
            </>
          )}
          <div className="cx-actions">
            <Button variant="outline" disabled={!provider || busy} onClick={() => void runTest()}>
              Test connection
            </Button>
            <div className="grow" />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!provider || busy || Object.keys(errors).length > 0}
              onClick={() => void connect()}
            >
              {edit ? 'Save' : 'Connect'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
