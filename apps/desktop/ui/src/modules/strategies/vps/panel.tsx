import { useCallback, useEffect, useRef, useState } from 'react';
import type { RawInputs } from '@htflow/indicator-sdk';
import { STRATEGIES, strategyById } from '@htflow/strategy';
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  NumberInput,
  Select,
  Table,
  toast,
} from '@htflow/ui-kit';
import { backend } from '../../../backend';
import { allInstruments } from '../../../state/instruments';
import { journalStore } from '../../journal/store';
import {
  BAR_SPECS,
  InputsForm,
  money,
  signedMoney,
  specOf as barSpecOf,
  specValue,
  toStrategyInstrument,
  tone,
} from '../shared';
import { compileProject } from '../editor/compile';
import { useScripts, vpsDeployRequest } from '../editor/store';
import { loadRunnerCore } from './bundle';
import type { RunnerConfig } from './core';
import { feedForInstrument, SUPPORTED_FEEDS } from './feeds';
import { errorCode, errorText, vaultKey, vpsNative } from './native';
import {
  healthOf,
  nodeInstallSteps,
  START_MODE_LABEL,
  startModes,
  uptimeText,
  type RemoteRunner,
  type RunnerHealth,
  type StartMode,
  type StatusReport,
} from './protocol';
import {
  deployRunner,
  HOSTS_KEY,
  makeRunnerConfig,
  newRunnerId,
  pollStatus,
  probeHost,
  pullTrips,
  runnerOp,
  sanitizeHosts,
  slug,
  specOf,
  validHost,
  validUser,
  type Deployment,
  type VpsHost,
} from './service';

import { translateLiteral as tl } from '@htflow/i18n';
const POLL_MS = 10_000;
/** Commands from the palette reach the mounted panel through this event. */
export const VPS_EVENT = 'htflow:vps';
export type VpsAction = 'add' | 'deploy' | 'refresh' | 'import';

const HEALTH_LABEL: Record<RunnerHealth, string> = {
  running: 'Running',
  starting: 'Starting',
  stale: 'No heartbeat',
  stopped: 'Stopped',
  error: 'Error',
  'not-started': 'Not started',
};

interface Live {
  connected: boolean;
  busy: string | null;
  error: string | null;
  report: StatusReport | null;
  polledAt: number;
}
const idle = (): Live => ({ connected: false, busy: null, error: null, report: null, polledAt: 0 });

export function VpsPanel() {
  const native = vpsNative();
  const [hosts, setHosts] = useState<VpsHost[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [dialog, setDialog] = useState<'add' | 'deploy' | null>(null);
  const [redeploy, setRedeploy] = useState<Deployment | null>(null);
  const [selRunner, setSelRunner] = useState<string | null>(null);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  useEffect(() => {
    void backend.loadSettings<VpsHost[]>(HOSTS_KEY).then((v) => {
      const l = sanitizeHosts(v);
      setHosts(l);
      setSel((s) => s ?? l[0]?.id ?? null);
    });
  }, []);

  const save = useCallback((l: VpsHost[]) => {
    hostsRef.current = l;
    setHosts(l);
    void backend.saveSettings(HOSTS_KEY, l);
  }, []);
  const patchHost = useCallback(
    (id: string, p: (h: VpsHost) => VpsHost) =>
      save(hostsRef.current.map((h) => (h.id === id ? p(h) : h))),
    [save],
  );
  const setL = useCallback(
    (id: string, p: Partial<Live>) =>
      setLive((m) => ({ ...m, [id]: { ...(m[id] ?? idle()), ...p } })),
    [],
  );

  const cur = hosts.find((h) => h.id === sel) ?? null;
  const st = cur ? (live[cur.id] ?? idle()) : idle();
  const curId = cur?.id;
  const curOs = cur?.os;

  const fail = useCallback(
    (id: string, what: string, e: unknown) => {
      const code = errorCode(e);
      setL(id, { busy: null, error: errorText(e), connected: code === 'vps.remote' });
      toast(
        code === 'vps.host_key_mismatch' ? 'error' : 'warning',
        `${what} failed`,
        errorText(e),
        8000,
      );
    },
    [setL],
  );

  /** Pulls new closed trips of every deployment into the journal ("VPS" account). */
  const importAll = useCallback(
    async (h: VpsHost, quiet = true) => {
      let added = 0;
      for (const d of h.deployments) {
        try {
          const r = await pullTrips(native, h, d);
          if (!r.lines) continue;
          added += journalStore.importTrips(r.trips, [{ text: 'vps', kind: 'custom' }]);
          patchHost(h.id, (x) => ({
            ...x,
            deployments: x.deployments.map((y) =>
              y.runnerId === d.runnerId ? { ...y, importedLines: y.importedLines + r.lines } : y,
            ),
          }));
        } catch {
          /* the status poll reports connection problems */
        }
      }
      if (!quiet) toast('success', tl('Journal updated'), `${added} new VPS trade(s) imported`);
    },
    [native, patchHost],
  );

  const refresh = useCallback(
    async (h: VpsHost, quiet = false) => {
      if (!h.os) return;
      if (!quiet) setL(h.id, { busy: 'Refreshing…' });
      try {
        const report = await pollStatus(native, h);
        setL(h.id, { busy: null, error: null, connected: true, report, polledAt: Date.now() });
        await importAll(h);
      } catch (e) {
        if (quiet) setL(h.id, { error: errorText(e), connected: false });
        else fail(h.id, 'Refresh', e);
      }
    },
    [native, importAll, setL, fail],
  );

  // Poll the selected, connected VPS while the panel is open.
  useEffect(() => {
    if (!curId || !curOs || !st.connected) return;
    const t = setInterval(() => {
      const h = hostsRef.current.find((x) => x.id === curId);
      if (h && document.visibilityState !== 'hidden') void refresh(h, true);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [curId, curOs, st.connected, refresh]);

  const test = async (h: VpsHost) => {
    setL(h.id, { busy: 'Connecting…', error: null });
    try {
      await native.connect(specOf(h));
      setL(h.id, { busy: 'Checking the system…', connected: true });
      const probe = await probeHost(native, h);
      const next = { ...h, os: probe.os, probe };
      patchHost(h.id, () => next);
      setL(h.id, { busy: null });
      toast(
        probe.nodeOk ? 'success' : 'warning',
        `Connected to ${h.name}`,
        `${probe.osName} ${probe.arch} · Node.js ${probe.node ?? 'not installed'}`,
      );
      await refresh(next, true);
    } catch (e) {
      fail(h.id, 'Connection', e);
    }
  };

  const act = async (h: VpsHost, d: Deployment, kind: 'start' | 'stop' | 'remove') => {
    setL(h.id, { busy: `${kind[0]!.toUpperCase()}${kind.slice(1)}ing ${d.runnerId}…` });
    try {
      if (kind !== 'start') await importAll(h);
      await runnerOp(native, h, kind, d);
      if (kind === 'remove')
        patchHost(h.id, (x) => ({
          ...x,
          deployments: x.deployments.filter((y) => y.runnerId !== d.runnerId),
        }));
      setL(h.id, { busy: null });
      toast(
        'success',
        `Runner ${d.runnerId}`,
        kind === 'remove' ? 'Removed from the VPS' : `${kind === 'start' ? 'Started' : 'Stopped'}`,
      );
      await refresh(hostsRef.current.find((x) => x.id === h.id) ?? h, true);
    } catch (e) {
      fail(h.id, kind, e);
    }
  };

  const removeHost = async (h: VpsHost) => {
    await native.disconnect(h.id).catch(() => undefined);
    for (const w of ['key', 'passphrase', 'password'] as const)
      await backend.vaultPut(vaultKey(h.id, w), '').catch(() => undefined);
    save(hosts.filter((x) => x.id !== h.id));
    setSel(hosts.find((x) => x.id !== h.id)?.id ?? null);
  };

  // Command Palette actions.
  useEffect(() => {
    const on = (ev: Event) => {
      const a = (ev as CustomEvent<VpsAction>).detail;
      const h = hostsRef.current.find((x) => x.id === sel) ?? hostsRef.current[0];
      if (a === 'add') setDialog('add');
      else if (a === 'deploy' && h) setDialog('deploy');
      else if (a === 'refresh' && h) void refresh(h);
      else if (a === 'import' && h) void importAll(h, false);
    };
    window.addEventListener(VPS_EVENT, on);
    return () => window.removeEventListener(VPS_EVENT, on);
  }, [sel, refresh, importAll]);

  const runners = (h: VpsHost): { d: Deployment | null; r: RemoteRunner | null; id: string }[] => {
    const rep = live[h.id]?.report;
    const ids = new Set([
      ...h.deployments.map((d) => d.runnerId),
      ...(rep?.runners.map((r) => r.id) ?? []),
    ]);
    return [...ids].map((id) => ({
      id,
      d: h.deployments.find((d) => d.runnerId === id) ?? null,
      r: rep?.runners.find((r) => r.id === id) ?? null,
    }));
  };
  const rows = cur ? runners(cur) : [];
  const now = st.report?.now ?? Date.now();
  const selRow = rows.find((x) => x.id === selRunner) ?? rows[0];

  return (
    <div className="stg-vps" data-testid="strategy-vps">
      {native.kind === 'none' && (
        <div className="stg-banner" role="note" data-testid="vps-desktop-only">
          <b>{tl('Desktop app needed.')}</b>{' '}
          {tl(
            'The browser build cannot open SSH connections. Install HT Flow on Windows to connect your VPS.',
          )}
        </div>
      )}
      <div className="stg-vps-intro stg-muted">
        {tl('Run strategies 24/7 on')} <b>{tl('your own VPS')}</b>{' '}
        {tl('over SSH — no HT Flow server, $0. The runner streams public market data (')}
        {SUPPORTED_FEEDS}
        {tl(') and trades')} <b>{tl('paper only')}</b>.
      </div>
      <div className="stg-vps-grid">
        <section className="stg-card">
          <div className="stg-card-head">
            <b>{tl('My VPS')}</b>
            <span className="grow" />
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setDialog('add')}
              data-testid="vps-add"
            >
              {tl('+ Add VPS')}
            </Button>
          </div>
          {hosts.length ? (
            <Table
              aria-label={tl('VPS hosts')}
              rows={hosts}
              rowId={(h) => h.id}
              height={170}
              selectionMode="single"
              selected={new Set(cur ? [cur.id] : [])}
              onSelectionChange={(s) => {
                const id = [...s][0];
                if (id) setSel(id);
              }}
              columns={[
                { key: 'name', header: 'Name', render: (h) => h.name },
                { key: 'host', header: 'Host', render: (h) => `${h.user}@${h.host}:${h.port}` },
                {
                  key: 'status',
                  header: 'Status',
                  width: 100,
                  render: (h) => {
                    const l = live[h.id];
                    return (
                      <span className={l?.connected ? 'up' : l?.error ? 'down' : 'stg-muted'}>
                        {l?.connected ? 'connected' : l?.error ? 'error' : 'not connected'}
                      </span>
                    );
                  },
                },
                {
                  key: 'n',
                  header: 'Runners',
                  width: 64,
                  numeric: true,
                  render: (h) => h.deployments.length,
                },
              ]}
            />
          ) : (
            <p className="stg-muted" data-testid="vps-empty">
              {tl('No VPS yet. Add one with its SSH host, user and key (or password).')}
            </p>
          )}
        </section>
        {cur && (
          <section className="stg-card" data-testid="vps-status">
            <div className="stg-card-head">
              <b>{cur.name}</b>
              {native.kind === 'mock' && <span className="stg-tag">{tl('mock VPS')}</span>}
              <span className="grow" />
              {st.busy && (
                <span className="stg-muted" data-testid="vps-busy">
                  {st.busy}
                </span>
              )}
            </div>
            <div className="stg-kv tnum">
              <span>{tl('Connection')}</span>
              <b className={st.connected ? 'up' : st.error ? 'down' : ''} data-testid="vps-conn">
                {st.connected ? 'Connected' : st.error ? 'Error' : 'Not connected'}
              </b>
              <span>{tl('Host')}</span>
              <b>{`${cur.user}@${cur.host}:${cur.port}`}</b>
              <span>{tl('Auth')}</span>
              <b>{cur.auth === 'key' ? 'SSH key (vault)' : 'Password (vault)'}</b>
              <span>{tl('Host key')}</span>
              <b className="vps-fp" title={cur.fingerprint} data-testid="vps-fingerprint">
                {cur.pinHostKey ? cur.fingerprint || '—' : 'not pinned (any key accepted)'}
              </b>
              <span>{tl('System')}</span>
              <b>{cur.probe ? `${cur.probe.osName} ${cur.probe.arch}` : '—'}</b>
              <span>{tl('Node.js')}</span>
              <b
                className={cur.probe ? (cur.probe.nodeOk ? 'up' : 'down') : ''}
                data-testid="vps-node"
              >
                {cur.probe ? (cur.probe.node ?? 'not installed') : '—'}
              </b>
            </div>
            {st.error && (
              <div className="stg-banner" role="alert" data-testid="vps-error">
                {st.error}
              </div>
            )}
            {cur.probe && !cur.probe.nodeOk && <NodeHelp host={cur} />}
            {cur.probe?.os === 'linux' && cur.probe.systemd && cur.probe.linger === 'no' && (
              <p className="stg-muted">
                {tl('Tip: systemd user services stop when you log out unless lingering is on:')}{' '}
                <code>
                  {tl('sudo loginctl enable-linger')} {cur.user}
                </code>
              </p>
            )}
            <div className="stg-actions">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void test(cur)}
                data-testid="vps-test"
              >
                {tl('Test connection')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!cur.os}
                onClick={() => void refresh(cur)}
                data-testid="vps-refresh"
              >
                {tl('Refresh')}
              </Button>
              <Button
                size="sm"
                disabled={!cur.probe?.nodeOk}
                onClick={() => {
                  setRedeploy(null);
                  setDialog('deploy');
                }}
                data-testid="vps-deploy"
              >
                {tl('Deploy strategy…')}
              </Button>
              <span className="grow" />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void native.disconnect(cur.id);
                  setL(cur.id, { connected: false });
                }}
              >
                {tl('Disconnect')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void removeHost(cur)}
                data-testid="vps-remove-host"
              >
                {tl('Remove VPS')}
              </Button>
            </div>
          </section>
        )}
      </div>
      {cur && (
        <section className="stg-card" data-testid="vps-runners">
          <div className="stg-card-head">
            <b>
              {tl('Runners on')} {cur.name}
            </b>
            <span className="stg-tag">{tl('paper')}</span>
            <span className="grow" />
            <Button
              size="xs"
              variant="ghost"
              disabled={!cur.os}
              onClick={() => void importAll(cur, false)}
              data-testid="vps-import"
            >
              {tl('Import fills to Journal')}
            </Button>
          </div>
          {rows.length ? (
            <Table
              aria-label={tl('VPS runners')}
              rows={rows}
              rowId={(x) => x.id}
              height={180}
              selectionMode="single"
              selected={new Set(selRow ? [selRow.id] : [])}
              onSelectionChange={(s) => setSelRunner([...s][0] ?? null)}
              columns={[
                {
                  key: 'id',
                  header: 'Runner',
                  render: (x) => x.d?.strategyName ?? x.r?.state?.strategyName ?? x.id,
                },
                {
                  key: 'sym',
                  header: 'Symbol',
                  width: 110,
                  render: (x) => x.d?.symbol ?? x.r?.state?.symbol ?? '—',
                },
                {
                  key: 'st',
                  header: 'Status',
                  width: 96,
                  render: (x) => {
                    const h = x.r ? healthOf(x.r, now) : null;
                    return (
                      <span
                        className={
                          h === 'running'
                            ? 'up'
                            : h === 'error' || h === 'stale'
                              ? 'down'
                              : 'stg-muted'
                        }
                        data-testid={`vps-runner-status-${x.id}`}
                      >
                        {h ? HEALTH_LABEL[h] : st.report ? 'Not on VPS' : '—'}
                      </span>
                    );
                  },
                },
                {
                  key: 'up',
                  header: 'Uptime',
                  width: 80,
                  render: (x) =>
                    x.r?.alive && x.r.state ? uptimeText(now - x.r.state.startedAt) : '—',
                },
                {
                  key: 'pnl',
                  header: 'P&L',
                  width: 90,
                  numeric: true,
                  render: (x) => {
                    const s = x.r?.state;
                    if (!s) return '—';
                    const v = s.realized + s.position.openPnl;
                    return (
                      <span className={tone(v)} data-testid={`vps-runner-pnl-${x.id}`}>
                        {signedMoney(v, 2)}
                      </span>
                    );
                  },
                },
                {
                  key: 'pos',
                  header: 'Pos',
                  width: 48,
                  numeric: true,
                  render: (x) => x.r?.state?.position.qty ?? '—',
                },
                {
                  key: 'tr',
                  header: 'Trades',
                  width: 56,
                  numeric: true,
                  render: (x) => x.r?.state?.trips ?? '—',
                },
              ]}
            />
          ) : (
            <p className="stg-muted">{tl('Nothing deployed yet.')}</p>
          )}
          {selRow && (
            <div className="vps-runner-detail" data-testid="vps-runner-detail">
              <div className="stg-actions">
                {selRow.d && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!cur.os}
                      onClick={() => void act(cur, selRow.d!, 'start')}
                      data-testid="vps-start"
                    >
                      {tl('Start')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!cur.os}
                      onClick={() => void act(cur, selRow.d!, 'stop')}
                      data-testid="vps-stop"
                    >
                      {tl('Stop')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!cur.probe?.nodeOk}
                      onClick={() => {
                        setRedeploy(selRow.d);
                        setDialog('deploy');
                      }}
                      data-testid="vps-redeploy"
                    >
                      {tl('Redeploy…')}
                    </Button>
                  </>
                )}
                <span className="grow" />
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!cur.os}
                  onClick={() =>
                    void act(
                      cur,
                      selRow.d ?? ({ runnerId: selRow.id, startMode: 'nohup' } as Deployment),
                      'remove',
                    )
                  }
                  data-testid="vps-remove-runner"
                >
                  {tl('Remove runner')}
                </Button>
              </div>
              {selRow.r?.state?.error && <div className="stg-banner">{selRow.r.state.error}</div>}
              {selRow.d && (
                <p className="stg-muted tnum">
                  {tl('Bundle')} {selRow.d.sha256.slice(0, 12)} ·{' '}
                  {(selRow.d.bytes / 1024).toFixed(0)} {tl('KB · deployed')}{' '}
                  {new Date(selRow.d.deployedAt).toLocaleString()} ·{' '}
                  {START_MODE_LABEL[selRow.d.startMode]}
                </p>
              )}
              <div className="stg-subhead">{tl('Last log lines')}</div>
              <pre className="vps-log" data-testid="vps-log">
                {(selRow.r?.logs ?? [])
                  .map(
                    (l) =>
                      `${new Date(l.ts).toLocaleTimeString()} ${l.level.toUpperCase()} ${l.msg}`,
                  )
                  .join('\n') || 'No log yet — Refresh to poll the VPS.'}
              </pre>
            </div>
          )}
        </section>
      )}
      {cur && cur.os && <Console host={cur} />}
      {dialog === 'add' && (
        <AddVps
          taken={hosts.map((h) => h.id)}
          onClose={() => setDialog(null)}
          onSave={(h) => {
            save([...hostsRef.current, h]);
            setSel(h.id);
            setDialog(null);
            void test(h);
          }}
        />
      )}
      {dialog === 'deploy' && cur && (
        <DeployDialog
          host={cur}
          existing={redeploy}
          onClose={() => setDialog(null)}
          onDeployed={(d) => {
            patchHost(cur.id, (x) => ({
              ...x,
              deployments: [...x.deployments.filter((y) => y.runnerId !== d.runnerId), d],
            }));
            setSelRunner(d.runnerId);
            setDialog(null);
            void refresh({ ...cur, deployments: [...cur.deployments, d] }, true);
          }}
        />
      )}
    </div>
  );
}

function NodeHelp({ host }: { host: VpsHost }) {
  const s = nodeInstallSteps({ os: host.probe!.os, distro: host.probe!.distro });
  return (
    <div className="stg-banner" role="note" data-testid="vps-node-help">
      <b>{tl('Node.js 22+ is required on the VPS')}</b> {tl('(found:')} {host.probe?.node ?? 'none'}
      {tl('). Install it yourself —')} {tl(s.title)}:
      <pre className="vps-log">{s.commands.join('\n')}</pre>
      <span className="stg-muted">{s.note}</span>
    </div>
  );
}

/** Runs the user's own commands on their VPS with streamed output. */
function Console({ host }: { host: VpsHost }) {
  const [cmd, setCmd] = useState('node --version');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setOut('');
    try {
      const code = await vpsNative().exec(specOf(host), cmd, (_s, d) =>
        setOut((o) => (o + d).slice(-20_000)),
      );
      setOut((o) => `${o}\n[exit ${code ?? '?'}]`);
    } catch (e) {
      setOut((o) => `${o}\n[error] ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="stg-card" data-testid="vps-console">
      <summary>{tl('Remote command')}</summary>
      <div className="stg-dialog-row">
        <Input
          aria-label={tl('Remote command')}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void run()}
          style={{ flex: 1 }}
        />
        <Button
          size="sm"
          disabled={busy || !cmd.trim()}
          onClick={() => void run()}
          data-testid="vps-run"
        >
          {tl('Run')}
        </Button>
      </div>
      <pre className="vps-log" data-testid="vps-console-out">
        {out}
      </pre>
    </details>
  );
}

function AddVps({
  taken,
  onClose,
  onSave,
}: {
  taken: string[];
  onClose(): void;
  onSave(h: VpsHost): void;
}) {
  const [name, setName] = useState('My VPS');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [user, setUser] = useState('');
  const [auth, setAuth] = useState<'key' | 'password'>('key');
  const [key, setKey] = useState('');
  const [pass, setPass] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hostOk = validHost(host);
  const userOk = validUser(user);
  const secretOk =
    auth === 'key' ? /PRIVATE KEY|PuTTY-User-Key-File/.test(key) : password.length > 0;
  const valid = hostOk && userOk && secretOk && name.trim().length > 0;

  const id = (() => {
    const base = `vps-${slug(name) || 'host'}`.slice(0, 32);
    let i = base;
    for (let n = 2; taken.includes(i); n++) i = `${base}-${n}`;
    return i;
  })();

  const finish = async (fingerprint: string) => {
    setBusy(true);
    try {
      if (auth === 'key') {
        await backend.vaultPut(vaultKey(id, 'key'), key.trim() + '\n');
        await backend.vaultPut(vaultKey(id, 'passphrase'), pass);
        await backend.vaultPut(vaultKey(id, 'password'), '');
      } else {
        await backend.vaultPut(vaultKey(id, 'password'), password);
        await backend.vaultPut(vaultKey(id, 'key'), '');
        await backend.vaultPut(vaultKey(id, 'passphrase'), '');
      }
      onSave({
        id,
        name: name.trim(),
        host: host.trim().replace(/^\[|\]$/g, ''),
        port,
        user: user.trim(),
        auth,
        fingerprint,
        pinHostKey: pin,
        deployments: [],
      });
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  const next = async () => {
    setErr(null);
    if (!pin) return finish('');
    setBusy(true);
    try {
      setConfirm(await vpsNative().hostKey(host.trim().replace(/^\[|\]$/g, ''), port, user.trim()));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (confirm)
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={tl('Trust this server?')}
        width={480}
      >
        <div className="stg-form" data-testid="vps-trust-dialog">
          <p>
            {tl('First connection to')}{' '}
            <b>
              {host}:{port}
            </b>
            {tl('. Its SSH host key fingerprint is:')}
          </p>
          <code className="vps-fp-big" data-testid="vps-trust-fp">
            {confirm}
          </code>
          <p className="stg-muted">
            {tl('Compare it with the one your VPS provider shows (or run')}{' '}
            <code>{tl('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')}</code>{' '}
            {tl('on the server). HT Flow pins it and refuses to connect if it ever changes.')}
          </p>
          <div className="stg-dialog-foot">
            <span className="grow" />
            <Button variant="ghost" onClick={onClose}>
              {tl('Cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void finish(confirm)} data-testid="vps-trust">
              {tl('Trust and save')}
            </Button>
          </div>
        </div>
      </Dialog>
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={tl('Add VPS')} width={460}>
      <div className="stg-form" data-testid="vps-add-dialog">
        <Field label={tl('Name')}>
          <Input
            aria-label={tl('Name')}
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 40))}
          />
        </Field>
        <Field label={tl('Host')} error={host && !hostOk ? 'Host name or IP address' : undefined}>
          <Input
            aria-label={tl('Host')}
            value={host}
            placeholder={tl('vps.example.com')}
            onChange={(e) => setHost(e.target.value.trim())}
          />
        </Field>
        <div className="stg-dialog-row">
          <Field label={tl('SSH port')}>
            <NumberInput value={port} min={1} max={65535} onChange={setPort} />
          </Field>
          <Field label={tl('User')} error={user && !userOk ? 'Letters, digits, . _ -' : undefined}>
            <Input
              aria-label={tl('User')}
              value={user}
              placeholder={tl('trader')}
              onChange={(e) => setUser(e.target.value.trim().slice(0, 64))}
            />
          </Field>
        </div>
        <div className="stg-dialog-row">
          <Checkbox
            radio
            checked={auth === 'key'}
            onChange={() => setAuth('key')}
            label={tl('SSH private key')}
          />
          <Checkbox
            radio
            checked={auth === 'password'}
            onChange={() => setAuth('password')}
            label={tl('Password')}
          />
        </div>
        {auth === 'key' ? (
          <>
            <Field
              label={tl('Private key')}
              hint={tl('OpenSSH, PEM or PuTTY .ppk. Stored only in the encrypted vault.')}
            >
              <input
                type="file"
                aria-label={tl('Private key file')}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size < 64 * 1024) void f.text().then(setKey);
                }}
              />
              <textarea
                className="vps-key"
                aria-label={tl('Private key text')}
                placeholder={tl('…or paste -----BEGIN OPENSSH PRIVATE KEY-----')}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                rows={4}
                spellCheck={false}
              />
            </Field>
            <Field label={tl('Key passphrase (if any)')}>
              <Input
                aria-label={tl('Key passphrase')}
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <Field
            label={tl('Password')}
            hint={tl('Stored only in the encrypted vault. A key is safer.')}
          >
            <Input
              aria-label={tl('Password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        <Checkbox
          checked={pin}
          onChange={setPin}
          label={tl("Pin the server's host key (trust on first use — recommended)")}
        />
        {!pin && (
          <div className="stg-banner">
            {tl(
              'Without pinning, a man-in-the-middle could impersonate your VPS. Only turn this off on a trusted private network.',
            )}
          </div>
        )}
        {err && (
          <div className="stg-banner" role="alert" data-testid="vps-add-error">
            {err}
          </div>
        )}
        <div className="stg-dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {tl('Cancel')}
          </Button>
          <Button disabled={!valid || busy} onClick={() => void next()} data-testid="vps-add-next">
            {pin ? 'Next: check host key' : 'Save'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DeployDialog({
  host,
  existing,
  onClose,
  onDeployed,
}: {
  host: VpsHost;
  existing: Deployment | null;
  onClose(): void;
  onDeployed(d: Deployment): void;
}) {
  const insts = allInstruments(true).filter((i) => feedForInstrument(i.id));
  const scripts = useScripts();
  const [strategyId, setStrategy] = useState(
    existing?.strategyId ??
      (vpsDeployRequest.projectId ? `script:${vpsDeployRequest.projectId}` : STRATEGIES[0]!.id),
  );
  useEffect(() => {
    vpsDeployRequest.projectId = null;
  }, []);
  const script = strategyId.startsWith('script:')
    ? scripts.find((x) => `script:${x.id}` === strategyId)
    : undefined;
  const [instrumentId, setInst] = useState(
    existing?.instrumentId ?? insts[0]?.id ?? 'binance-futures:BTCUSDT',
  );
  const [bars, setBars] = useState(existing ? specValue(existing.bars) : 't300000');
  const [inputs, setInputs] = useState<RawInputs>(existing?.inputs ?? {});
  const [maxPos, setMaxPos] = useState(existing?.maxPosition ?? 5);
  const modes = startModes({ os: host.os ?? 'linux', systemd: host.probe?.systemd ?? false });
  const [mode, setMode] = useState<StartMode>(
    existing && modes.includes(existing.startMode) ? existing.startMode : modes[0]!,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const builtin = strategyById(strategyId);
  const def = builtin ?? (script ? { name: script.name, inputs: {} } : undefined);
  const inst = insts.find((i) => i.id === instrumentId);
  const feed = feedForInstrument(instrumentId);

  const deploy = async () => {
    if (!def || !inst || !feed) return;
    let scriptCfg: RunnerConfig['script'];
    if (script) {
      const c = compileProject(script.files);
      if (!c.project) {
        toast('error', tl('The strategy does not compile'), c.diagnostics[0]?.message);
        return;
      }
      scriptCfg = { project: c.project, params: script.params };
    }
    const runnerId =
      existing?.runnerId ??
      newRunnerId(
        strategyId,
        feed.symbol,
        host.deployments.map((d) => d.runnerId),
      );
    const cfg = makeRunnerConfig({
      host,
      runnerId,
      strategyId,
      strategyName: def.name,
      inputs,
      instrument: toStrategyInstrument(inst),
      feed,
      bars: barSpecOf(bars),
      maxPosition: maxPos,
      script: scriptCfg,
    });
    try {
      setBusy('Bundling the runner…');
      const core = await loadRunnerCore();
      setBusy('Uploading and starting…');
      const r = await deployRunner(vpsNative(), host, cfg, mode, core, !!existing);
      onDeployed({
        runnerId,
        strategyId,
        strategyName: def.name,
        instrumentId,
        symbol: feed.symbol,
        exchange: feed.exchange,
        inputs,
        bars: cfg.bars,
        maxPosition: maxPos,
        startMode: mode,
        createdAt: existing?.createdAt ?? cfg.deployedAt,
        deployedAt: cfg.deployedAt,
        sha256: r.sha256,
        bytes: r.bytes,
        importedLines: existing?.importedLines ?? 0,
      });
      toast(
        'success',
        `Deployed ${def.name}`,
        `Runner ${runnerId} is starting on ${host.name} (paper).`,
      );
    } catch (e) {
      setBusy(null);
      toast('error', tl('Deploy failed'), errorText(e), 8000);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`${existing ? 'Redeploy' : 'Deploy'} to ${host.name}`}
      width={480}
    >
      <div className="stg-form" data-testid="vps-deploy-dialog">
        <div className="stg-banner" role="note">
          <b>{tl('Paper trading.')}</b>{' '}
          {tl(
            'The runner simulates fills with the HT Flow paper engine on live public data. Live order routing from a VPS needs a broker connector (not available yet).',
          )}
        </div>
        <Field label={tl('Strategy')}>
          <Select
            value={strategyId}
            options={[
              ...STRATEGIES.map((s) => ({ value: s.id, label: s.name })),
              ...scripts.map((x) => ({ value: `script:${x.id}`, label: `HT Editor: ${x.name}` })),
            ]}
            onChange={(v) => {
              setStrategy(v);
              setInputs({});
            }}
          />
        </Field>
        <Field
          label={tl('Instrument')}
          hint={
            insts.length ? undefined : `No supported instrument. Supported: ${SUPPORTED_FEEDS}.`
          }
        >
          <Select
            value={instrumentId}
            options={(insts.length ? insts : []).map((i) => ({
              value: i.id,
              label: `${i.symbol} · ${i.exchange}`,
            }))}
            onChange={setInst}
          />
        </Field>
        <div className="stg-dialog-row">
          <Field label={tl('Bars')}>
            <Select
              value={bars}
              options={BAR_SPECS.map((b) => ({ value: b.value, label: b.label }))}
              onChange={setBars}
            />
          </Field>
          <Field label={tl('Max position (risk cap)')}>
            <NumberInput value={maxPos} min={1} max={10_000} onChange={setMaxPos} />
          </Field>
        </div>
        {def && Object.keys(def.inputs).length > 0 && (
          <Field label={tl('Inputs')}>
            <InputsForm
              defs={def.inputs}
              values={inputs}
              onChange={setInputs}
              testId="vps-deploy-inputs"
            />
          </Field>
        )}
        <Field label={tl('Keep running with')}>
          <Select
            value={mode}
            options={modes.map((m) => ({ value: m, label: START_MODE_LABEL[m] }))}
            onChange={(v) => setMode(v as StartMode)}
          />
        </Field>
        <p className="stg-muted">
          {tl('Starting balance')} {money(50_000)}{' '}
          {tl('(paper). The bundle (SDK + strategy + inputs) is uploaded to')}{' '}
          <code>{tl('~/.htflow-runner/runners/')}</code>.
        </p>
        <div className="stg-dialog-foot">
          {busy && <span className="stg-muted">{busy}</span>}
          <span className="grow" />
          <Button variant="ghost" disabled={!!busy} onClick={onClose}>
            {tl('Cancel')}
          </Button>
          <Button
            disabled={!!busy || !def || !inst || !feed}
            onClick={() => void deploy()}
            data-testid="vps-deploy-go"
          >
            {existing ? 'Redeploy' : 'Deploy'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
