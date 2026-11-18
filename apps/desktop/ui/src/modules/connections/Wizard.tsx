import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Badge, Button, Checkbox, Dialog, Field, Input, NumberInput, Select } from '@htflow/ui-kit';
import { backend, isTauri } from '../../backend';
import { paper } from '../../state/market';
import { setVenueEnabled } from '../../state/liveFeed';
import { useConnections } from './store';
import { DEFAULT_WS_CONFIG, parseMappingText, renderSubscribe } from './customWs';
import { testCustomWs } from './customWsFeed';
import {
  isAvailable,
  providerById,
  searchProviders,
  validateConnection,
  type ConnectionConfig,
  type Provider,
} from './providers';

import { translateLiteral as tl, tt } from '@htflow/i18n';
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
    trading: p.form !== 'crypto' && p.form !== 'ws' && p.form !== 'import',
    ws: p.form === 'ws' ? structuredClone(DEFAULT_WS_CONFIG) : undefined,
    record: p.form === 'crypto',
    connectOnStart: p.form !== 'broker',
  };
}

/** Add / edit connection (P32): step 1 provider tree, step 2 provider form. */
export function ConnectionWizard({
  open,
  onClose,
  edit,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  edit?: ConnectionConfig;
  /** Opens the CSV importer (the "CSV / Parquet import" provider). */
  onImport?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<Provider | null>(
    edit ? (providerById(edit.provider) ?? null) : null,
  );
  const [form, setForm] = useState<ConnectionConfig | null>(edit ?? null);
  const [secret, setSecret] = useState({ apiKey: '', apiSecret: '', password: '' });
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [mappingText, setMappingText] = useState(() =>
    JSON.stringify(edit?.ws?.mapping ?? DEFAULT_WS_CONFIG.mapping, null, 2),
  );
  const mappingErr = parseMappingText(mappingText).error;
  const groups = useMemo(() => searchProviders(query), [query]);
  const errors = provider && form ? validateConnection(provider, form) : {};
  const upsert = useConnections((s) => s.upsert);

  const pick = (p: Provider) => {
    setProvider(p);
    const f = edit && edit.provider === p.id ? edit : blank(p);
    setForm(f);
    setMappingText(JSON.stringify(f.ws?.mapping ?? DEFAULT_WS_CONFIG.mapping, null, 2));
    setTest(null);
  };
  const patch = (p: Partial<ConnectionConfig>) => setForm((f) => (f ? { ...f, ...p } : f));
  const patchWs = (p: Partial<NonNullable<ConnectionConfig['ws']>>) =>
    setForm((f) => (f?.ws ? { ...f, ws: { ...f.ws, ...p } } : f));
  const editMapping = (text: string) => {
    setMappingText(text);
    const r = parseMappingText(text);
    if (r.mapping) patchWs({ mapping: r.mapping });
  };

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
    if (provider.form === 'import') {
      setTest({ ok: false, text: 'Nothing to connect: use Open CSV importer to load a file' });
      return;
    }
    if (provider.form === 'ws') {
      if (!form?.ws) return;
      if (mappingErr) {
        setTest({ ok: false, text: mappingErr });
        return;
      }
      setBusy(true);
      setTest({ ok: true, text: 'Connecting…' });
      try {
        setTest(await testCustomWs(form.ws));
      } finally {
        setBusy(false);
      }
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
        symbol: provider.testSymbol ?? 'BTCUSDT',
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
    setTried(true);
    if (!provider || !form || Object.keys(errors).length || (provider.form === 'ws' && mappingErr))
      return;
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

  const err = (k: string) => (form && tried ? errors[k] : undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={tt`${edit ? 'Edit connection' : 'Add connection'} · Step ${provider ? 2 : 1} of 2`}
      width={880}
    >
      <div className="cx-wizard">
        <div className="cx-tree">
          <Input
            placeholder={tl('Search providers…')}
            aria-label={tl('Search providers')}
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
            {!groups.length && (
              <div className="muted pad12">
                {tl('No provider matches “')}
                {query}”
              </div>
            )}
          </div>
        </div>
        <div className="cx-form">
          <div className="cx-scroll">
            {!provider || !form ? (
              <div className="muted pad12">
                {tl(
                  'Pick a provider on the left. FREE = public data or built-in; YOUR ACCOUNT = needs your own login / licence.',
                )}
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
                    {tl('Coming soon / requires SDK —')} {provider.blocked}
                    {tl(
                      '. You can save the connection now; it will show as unavailable until the connector ships.',
                    )}
                  </div>
                )}
                <Field label={tl('Connection name')} error={err('name')}>
                  <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} />
                </Field>
                {provider.form === 'crypto' && (
                  <>
                    <Field label={tl('API key (optional — only for trading)')}>
                      <Input
                        value={secret.apiKey}
                        autoComplete="off"
                        placeholder={form.hasSecret ? 'Stored in vault — leave empty to keep' : ''}
                        onChange={(e) => setSecret({ ...secret, apiKey: e.target.value })}
                      />
                    </Field>
                    <Field label={tl('API secret (optional)')}>
                      <Input
                        type="password"
                        value={secret.apiSecret}
                        autoComplete="off"
                        onChange={(e) => setSecret({ ...secret, apiSecret: e.target.value })}
                      />
                    </Field>
                    <Field label={tl('Environment')}>
                      <Select
                        aria-label={tl('Environment')}
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
                    <Field label={tl('Server / system')} error={err('server')}>
                      <Input
                        value={form.server ?? ''}
                        placeholder={tl('e.g. Paper Trading · Chicago')}
                        onChange={(e) => patch({ server: e.target.value })}
                      />
                    </Field>
                    <Field label={tl('Username')} error={err('username')}>
                      <Input
                        value={form.username ?? ''}
                        autoComplete="off"
                        onChange={(e) => patch({ username: e.target.value })}
                      />
                    </Field>
                    <Field label={tl('Password')}>
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
                        <Field label={tl('Gateway host')} error={err('gatewayHost')}>
                          <Input
                            value={form.gatewayHost ?? ''}
                            onChange={(e) => patch({ gatewayHost: e.target.value })}
                          />
                        </Field>
                        <Field label={tl('Port')} error={err('gatewayPort')}>
                          <NumberInput
                            aria-label={tl('Gateway port')}
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
                {provider.form === 'ws' && form.ws && (
                  <>
                    <Field label={tl('WebSocket URL (ws:// or wss://)')} error={err('url')}>
                      <Input
                        aria-label={tl('WebSocket URL')}
                        value={form.ws.url}
                        placeholder={tl('wss://example.com/stream')}
                        onChange={(e) => patchWs({ url: e.target.value })}
                      />
                    </Field>
                    <div className="row gap8">
                      <Field label={tl('Symbol')} error={err('symbol')}>
                        <Input
                          aria-label={tl('Symbol')}
                          value={form.ws.symbol}
                          onChange={(e) => patchWs({ symbol: e.target.value })}
                        />
                      </Field>
                      <Field label={tl('Tick size')} error={err('tickSize')}>
                        <NumberInput
                          aria-label={tl('Tick size')}
                          value={form.ws.tickSize}
                          min={0.00000001}
                          step={0.01}
                          onChange={(v) => patchWs({ tickSize: v })}
                        />
                      </Field>
                      <Field label={tl('Price decimals')}>
                        <NumberInput
                          aria-label={tl('Price decimals')}
                          value={form.ws.pricePrecision}
                          min={0}
                          max={8}
                          step={1}
                          onChange={(v) => patchWs({ pricePrecision: v })}
                        />
                      </Field>
                    </div>
                    <Field
                      label={tl('Subscribe message (JSON, optional; {symbol} is replaced)')}
                      error={err('subscribe')}
                    >
                      <textarea
                        className="ht-input cx-json"
                        aria-label={tl('Subscribe message')}
                        rows={2}
                        spellCheck={false}
                        value={form.ws.subscribe ?? ''}
                        onChange={(e) => patchWs({ subscribe: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={tl(
                        'Field mapping (JSON paths: price, qty, side, timestamp; optional bids / asks)',
                      )}
                      error={mappingErr ?? err('mapping')}
                      hint={tt`Subscribe sent: ${renderSubscribe(form.ws.subscribe ?? '', form.ws.symbol).text ?? 'nothing'}`}
                    >
                      <textarea
                        className="ht-input cx-json"
                        aria-label={tl('Field mapping')}
                        rows={9}
                        spellCheck={false}
                        value={mappingText}
                        onChange={(e) => editMapping(e.target.value)}
                      />
                    </Field>
                  </>
                )}
                {provider.form === 'import' && (
                  <div className="cx-note">
                    <Button
                      variant="outline"
                      onClick={() => {
                        onClose();
                        onImport?.();
                      }}
                    >
                      {tl('Open CSV importer')}
                    </Button>{' '}
                    {tl(
                      'Pick a file, map its columns, preview and import. Imported data appears in the instrument picker as “Imported files”.',
                    )}
                  </div>
                )}
                {provider.form === 'simulator' && (
                  <Field label={tl('Starting balance (USD)')} error={err('startingBalance')}>
                    <NumberInput
                      aria-label={tl('Starting balance')}
                      value={form.startingBalance ?? 50_000}
                      step={1000}
                      min={100}
                      max={100_000_000}
                      onChange={(v) => patch({ startingBalance: v })}
                    />
                  </Field>
                )}
                {provider.form !== 'import' && (
                  <div className="cx-options">
                    <Checkbox
                      label={tl('Use for market data')}
                      checked={form.marketData}
                      onChange={(v) => patch({ marketData: v })}
                    />
                    <Checkbox
                      label={tl('Use for trading (orders go to this connection)')}
                      checked={form.trading}
                      onChange={(v) => patch({ trading: v })}
                    />
                    <Checkbox
                      label={tl('Record ticks + depth to local history')}
                      checked={form.record}
                      onChange={(v) => patch({ record: v })}
                    />
                    <Checkbox
                      label={tl('Connect automatically on start')}
                      checked={form.connectOnStart}
                      onChange={(v) => patch({ connectOnStart: v })}
                    />
                    {err('options') && <span className="ht-error">{err('options')}</span>}
                  </div>
                )}
                {provider.form !== 'ws' && provider.form !== 'import' && (
                  <div className="cx-note">
                    {tl(
                      'Credentials are stored in your encrypted vault on this PC. They are never sent anywhere except to',
                    )}{' '}
                    {provider.name}.
                  </div>
                )}
                {provider.form === 'ws' && (
                  <div className="cx-note">
                    {tl(
                      'The URL is contacted directly from this PC. Nothing is sent anywhere else. In the desktop app the connection is opened by the HT Flow core (ws:// and wss:// only, messages up to 1 MB).',
                    )}
                  </div>
                )}
                {test && (
                  <div className={`cx-test ${test.ok ? 'ok' : 'bad'}`} role="status">
                    {test.text}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="cx-actions">
            <Button variant="outline" disabled={!provider || busy} onClick={() => void runTest()}>
              {tl('Test connection')}
            </Button>
            <div className="grow" />
            <Button variant="ghost" onClick={onClose}>
              {tl('Cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={
                !provider ||
                provider.form === 'import' ||
                busy ||
                (tried && Object.keys(errors).length > 0)
              }
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
