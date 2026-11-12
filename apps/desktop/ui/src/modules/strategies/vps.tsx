import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Input, NumberInput, Select, Table, toast } from '@htflow/ui-kit';
import { STRATEGIES } from '@htflow/strategy';
import { backend } from '../../backend';
import { allInstruments } from '../../state/instruments';
import { PAPER_ACCOUNT } from '../../state/market';
import { isTauri } from '../../backend';

/** A remote HT Flow Runner (P42). The runner itself is not built yet: this is the desktop side. */
export interface VpsRunner {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** Name of the SSH key entry in the vault. */
  keyRef: string;
  deployments: { strategyId: string; instrumentId: string; accountId: string; at: number }[];
  /** Demo entries show mock telemetry so the panel can be reviewed. */
  demo?: boolean;
}

const KEY = 'strategies.vps';
const BLOCKED =
  'Remote runs need a VPS running the HT Flow Runner (headless Rust core over an SSH tunnel). The runner binary is not built yet, so nothing is sent anywhere.';

const DEMO: VpsRunner = {
  id: 'demo',
  name: 'Demo VPS (mock data)',
  host: '203.0.113.10',
  port: 22,
  user: 'htflow',
  keyRef: 'vault:ssh/demo',
  deployments: [
    {
      strategyId: 'opening-range-breakout',
      instrumentId: 'mock:ESZ6',
      accountId: PAPER_ACCOUNT,
      at: 0,
    },
  ],
  demo: true,
};

function sanitize(raw: unknown): VpsRunner[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is VpsRunner =>
      !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.host === 'string',
  );
}

/** Mock telemetry (deterministic per runner) — clearly labelled in the UI. */
function mockStatus(r: VpsRunner) {
  if (!r.demo) return { online: false, ping: NaN, cpu: NaN, ram: NaN, uptime: '—' };
  return { online: true, ping: 18, cpu: 7, ram: 31, uptime: '3 d 4 h' };
}

const notBuilt = (what: string) => toast('warning', `${what}: runner not available`, BLOCKED, 6000);

export function VpsPanel() {
  const [list, setList] = useState<VpsRunner[]>([]);
  const [sel, setSel] = useState<string>('demo');
  const [dialog, setDialog] = useState<'add' | 'deploy' | null>(null);
  useEffect(() => {
    void backend.loadSettings<VpsRunner[]>(KEY).then((v) => setList(sanitize(v)));
  }, []);
  const save = (l: VpsRunner[]) => {
    setList(l);
    void backend.saveSettings(KEY, l);
  };
  const all = [DEMO, ...list];
  const cur = all.find((r) => r.id === sel) ?? DEMO;
  const st = mockStatus(cur);
  return (
    <div className="st-vps" data-testid="strategy-vps">
      <div className="st-banner" role="note" data-testid="vps-banner">
        <b>Requires your own VPS runner.</b> {BLOCKED} Strategies run on This PC (paper) meanwhile.
      </div>
      <div className="st-vps-grid">
        <section className="st-card">
          <div className="st-card-head">
            <b>Runners</b>
            <span className="grow" />
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setDialog('add')}
              data-testid="vps-add"
            >
              + Add runner
            </Button>
          </div>
          <Table
            aria-label="VPS runners"
            rows={all}
            rowId={(r) => r.id}
            height={200}
            selectionMode="single"
            selected={new Set([cur.id])}
            onSelectionChange={(s) => {
              const id = [...s][0];
              if (id) setSel(id);
            }}
            columns={[
              { key: 'name', header: 'Name', render: (r) => r.name },
              { key: 'host', header: 'Host', render: (r) => `${r.user}@${r.host}:${r.port}` },
              {
                key: 'status',
                header: 'Status',
                width: 90,
                render: (r) => (
                  <span className={mockStatus(r).online ? 'up' : 'st-muted'}>
                    {mockStatus(r).online ? 'online (demo)' : 'not connected'}
                  </span>
                ),
              },
              {
                key: 'dep',
                header: 'Strategies',
                width: 70,
                numeric: true,
                render: (r) => r.deployments.length,
              },
            ]}
          />
        </section>
        <section className="st-card" data-testid="vps-status">
          <div className="st-card-head">
            <b>{cur.name}</b>
            {cur.demo && <span className="st-tag">mock data</span>}
          </div>
          <div className="st-kv tnum">
            <span>Status</span>
            <b className={st.online ? 'up' : 'down'}>{st.online ? 'Online' : 'Offline'}</b>
            <span>Ping to broker</span>
            <b>{Number.isNaN(st.ping) ? '—' : `${st.ping} ms`}</b>
            <span>CPU / RAM</span>
            <b>{Number.isNaN(st.cpu) ? '—' : `${st.cpu}% / ${st.ram}%`}</b>
            <span>Uptime</span>
            <b>{st.uptime}</b>
            <span>SSH key</span>
            <b>{cur.keyRef}</b>
          </div>
          <div className="st-subhead">Deployed strategies</div>
          {cur.deployments.length ? (
            <ul className="st-deps">
              {cur.deployments.map((d, i) => (
                <li key={i}>
                  {STRATEGIES.find((s) => s.id === d.strategyId)?.name ?? d.strategyId} ·{' '}
                  {d.instrumentId} · {d.accountId}
                </li>
              ))}
            </ul>
          ) : (
            <p className="st-muted">Nothing deployed.</p>
          )}
          <div className="st-actions">
            <Button size="sm" variant="secondary" onClick={() => notBuilt('Test SSH')}>
              Test SSH
            </Button>
            <Button size="sm" variant="secondary" onClick={() => notBuilt('Install runner')}>
              Install runner
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDialog('deploy')}
              data-testid="vps-deploy"
            >
              Deploy strategy…
            </Button>
            <span className="grow" />
            <Button size="sm" variant="destructive" onClick={() => notBuilt('Kill switch')}>
              KILL SWITCH
            </Button>
            {!cur.demo && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  save(list.filter((r) => r.id !== cur.id));
                  setSel('demo');
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </section>
      </div>
      {dialog === 'add' && (
        <AddRunner
          onClose={() => setDialog(null)}
          onSave={(r) => {
            save([...list, r]);
            setSel(r.id);
          }}
        />
      )}
      {dialog === 'deploy' && (
        <DeployDialog
          runner={cur}
          onClose={() => setDialog(null)}
          onDeploy={(d) => {
            if (!cur.demo)
              save(
                list.map((r) =>
                  r.id === cur.id ? { ...r, deployments: [...r.deployments, d] } : r,
                ),
              );
            notBuilt('Deploy');
          }}
        />
      )}
    </div>
  );
}

function AddRunner({ onClose, onSave }: { onClose(): void; onSave(r: VpsRunner): void }) {
  const [name, setName] = useState('My VPS');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [user, setUser] = useState('htflow');
  const [keyRef, setKeyRef] = useState('vault:ssh/default');
  const valid = /^[a-z0-9.-]+$/i.test(host) && name.trim().length > 0 && user.trim().length > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add VPS runner" width={420}>
      <div className="st-form">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} />
        </Field>
        <Field label="Host" error={host && !valid ? 'Host name or IP address' : undefined}>
          <Input
            value={host}
            placeholder="vps.example.com"
            onChange={(e) => setHost(e.target.value.trim())}
          />
        </Field>
        <Field label="SSH port">
          <NumberInput value={port} min={1} max={65535} onChange={setPort} />
        </Field>
        <Field label="User">
          <Input value={user} onChange={(e) => setUser(e.target.value.trim().slice(0, 32))} />
        </Field>
        <Field label="SSH key (from the vault)" hint="Keys never leave the encrypted vault.">
          <Select
            value={keyRef}
            options={[
              { value: 'vault:ssh/default', label: 'Default SSH key' },
              { value: 'vault:ssh/vps', label: 'VPS key' },
            ]}
            onChange={setKeyRef}
          />
        </Field>
        <div className="st-dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave({
                id: `vps-${Date.now().toString(36)}`,
                name,
                host,
                port,
                user,
                keyRef,
                deployments: [],
              });
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DeployDialog({
  runner,
  onClose,
  onDeploy,
}: {
  runner: VpsRunner;
  onClose(): void;
  onDeploy(d: VpsRunner['deployments'][number]): void;
}) {
  const [strategyId, setStrategy] = useState(STRATEGIES[0]!.id);
  const insts = allInstruments(isTauri);
  const [instrumentId, setInst] = useState(insts[0]?.id ?? 'mock:ESZ6');
  const [accountId, setAcc] = useState(PAPER_ACCOUNT);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Deploy to ${runner.name}`}
      width={420}
    >
      <div className="st-form" data-testid="vps-deploy-dialog">
        <div className="st-banner">{BLOCKED}</div>
        <Field label="Strategy">
          <Select
            value={strategyId}
            options={STRATEGIES.map((s) => ({ value: s.id, label: s.name }))}
            onChange={setStrategy}
          />
        </Field>
        <Field label="Instrument">
          <Select
            value={instrumentId}
            options={insts.map((i) => ({ value: i.id, label: i.symbol }))}
            onChange={setInst}
          />
        </Field>
        <Field label="Account">
          <Select
            value={accountId}
            options={[{ value: PAPER_ACCOUNT, label: 'Paper' }]}
            onChange={setAcc}
          />
        </Field>
        <div className="st-dialog-foot">
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onDeploy({ strategyId, instrumentId, accountId, at: Date.now() });
              onClose();
            }}
          >
            Deploy
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
