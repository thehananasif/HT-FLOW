import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../../backend';
import type { RunnerConfig, RunnerState } from './core';
import type { RemoteOs, StartMode } from './protocol';

/** Connection details sent to the native side (no secrets: those stay in the vault). */
export interface ConnSpec {
  id: string;
  host: string;
  port: number;
  user: string;
  auth: 'key' | 'password';
  fingerprint?: string | null;
  trustAnyHostKey?: boolean;
}

export type VpsOp =
  | { kind: 'upload'; runnerId: string; file: string; content: string }
  | { kind: 'start'; runnerId: string; mode: StartMode }
  | { kind: 'stop'; runnerId: string }
  | { kind: 'remove'; runnerId: string }
  | { kind: 'status'; logLines: number }
  | { kind: 'trips'; runnerId: string; from: number; max: number }
  | { kind: 'logs'; runnerId: string; lines: number };

export interface OpOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface VpsNative {
  readonly kind: 'tauri' | 'mock' | 'none';
  hostKey(host: string, port: number, user: string): Promise<string>;
  keyInfo(id: string): Promise<{ publicKey: string; fingerprint: string }>;
  connect(spec: ConnSpec): Promise<string>;
  disconnect(id: string): Promise<void>;
  probe(spec: ConnSpec): Promise<{ os: RemoteOs; raw: string }>;
  op(spec: ConnSpec, os: RemoteOs, op: VpsOp): Promise<OpOutput>;
  exec(
    spec: ConnSpec,
    command: string,
    onData: (stream: 'out' | 'err', data: string) => void,
  ): Promise<number | null>;
}

/** Vault keys of a VPS's secrets (must match src-tauri/src/vps_cmds.rs). */
export const vaultKey = (id: string, what: 'key' | 'passphrase' | 'password') =>
  `vps/${id}/${what}`;

export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String(e.message);
  return String(e);
}
export function errorCode(e: unknown): string {
  return e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
}

const tauriNative: VpsNative = {
  kind: 'tauri',
  hostKey: async (host, port, user) =>
    (await invoke<{ fingerprint: string }>('vps_host_key', { host, port, user })).fingerprint,
  keyInfo: (id) => invoke('vps_key_info', { id }),
  connect: async (spec) =>
    (await invoke<{ fingerprint: string }>('vps_connect', { spec })).fingerprint,
  disconnect: (id) => invoke('vps_disconnect', { id }),
  probe: (spec) => invoke('vps_probe', { spec }),
  op: (spec, os, op) => invoke('vps_op', { spec, os, op }),
  exec: (spec, command, onData) => {
    const channel = new Channel<{ kind: 'out' | 'err'; data: string }>();
    channel.onmessage = (m) => onData(m.kind, m.data);
    return invoke<number | null>('vps_exec', { spec, command, timeoutS: 120, channel });
  },
};

const unavailable = (): Promise<never> =>
  Promise.reject({
    code: 'vps.desktop_only',
    message:
      'SSH to a VPS needs the HT Flow desktop app (the browser cannot open SSH connections).',
  });

const noneNative: VpsNative = {
  kind: 'none',
  hostKey: unavailable,
  keyInfo: unavailable,
  connect: unavailable,
  disconnect: async () => undefined,
  probe: unavailable,
  op: unavailable,
  exec: unavailable,
};

// ---------------------------------------------------------------------------------- mock VPS

export const MOCK_FINGERPRINT = 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM';

interface MockRunner {
  cfg: RunnerConfig;
  alive: boolean;
  startedAt: number;
  trips: string[];
}

/**
 * In-memory VPS for the web build's e2e tests and UI review (`window.__HTFLOW_VPS_MOCK__`). It
 * speaks the same output formats as the real remote commands, so parsing is exercised too.
 */
export function createMockNative(now: () => number = Date.now): VpsNative {
  const hosts = new Map<string, Map<string, MockRunner>>();
  const runnersOf = (id: string) => {
    let m = hosts.get(id);
    if (!m) hosts.set(id, (m = new Map()));
    return m;
  };
  const ok = (stdout: string): OpOutput => ({ code: 0, stdout, stderr: '', truncated: false });
  const check = (spec: ConnSpec) => {
    if (!spec.fingerprint && !spec.trustAnyHostKey)
      throw { code: 'vps.untrusted', message: "Confirm the server's host key fingerprint first" };
    if (spec.fingerprint && spec.fingerprint !== MOCK_FINGERPRINT)
      throw {
        code: 'vps.host_key_mismatch',
        message: `HOST KEY CHANGED: expected ${spec.fingerprint}, the server sent ${MOCK_FINGERPRINT}.`,
      };
    if (spec.host.startsWith('down.'))
      throw { code: 'vps.connect', message: 'cannot connect: Connection refused' };
  };
  const stateOf = (r: MockRunner, t: number): RunnerState => {
    const up = r.alive ? t - r.startedAt : 0;
    return {
      v: 1,
      runnerId: r.cfg.runnerId,
      strategyId: r.cfg.strategyId,
      strategyName: r.cfg.strategyName,
      symbol: r.cfg.feed.symbol,
      exchange: r.cfg.feed.exchange,
      status: r.alive ? 'running' : 'stopped',
      pid: r.alive ? 4242 : 0,
      startedAt: r.startedAt,
      updatedAt: r.alive ? t : r.startedAt,
      feed: { connected: r.alive, lastTradeTs: t, reconnects: 0, trades: Math.floor(up / 100) },
      lastPx: 650_000,
      position: { qty: r.alive ? 1 : 0, avgPx: 649_990, openPnl: r.alive ? 1 : 0 },
      realized: r.trips.reduce((a, l) => a + (JSON.parse(l) as { pnl: number }).pnl, 0),
      trips: r.trips.length,
      wins: r.trips.length,
      error: undefined,
    };
  };
  return {
    kind: 'mock',
    hostKey: async (host) => {
      if (host.startsWith('down.'))
        throw { code: 'vps.connect', message: 'cannot connect: Connection refused' };
      return MOCK_FINGERPRINT;
    },
    keyInfo: async () => ({
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockPublicKeyForTheWebBuildOnly htflow',
      fingerprint: 'SHA256:mockclientkey',
    }),
    connect: async (spec) => {
      check(spec);
      return MOCK_FINGERPRINT;
    },
    disconnect: async () => undefined,
    probe: async (spec) => {
      check(spec);
      const noNode = spec.host.startsWith('nonode.');
      return {
        os: 'linux',
        raw: `os=Linux\narch=x86_64\nnode=${noNode ? 'none' : 'v22.11.0'}\nsystemd=yes\nlinger=yes\ndistro=ubuntu\nhome=/home/${spec.user}\n`,
      };
    },
    op: async (spec, _os, op) => {
      check(spec);
      const rs = runnersOf(spec.id);
      const t = now();
      switch (op.kind) {
        case 'upload': {
          const m = /__HTFLOW_RUNNER_CONFIG__ = (.*);\n/.exec(op.content);
          if (!m) return { code: 1, stdout: '', stderr: 'bad bundle', truncated: false };
          const cfg = JSON.parse(m[1]!) as RunnerConfig;
          const prev = rs.get(op.runnerId);
          rs.set(op.runnerId, { cfg, alive: false, startedAt: t, trips: prev?.trips ?? [] });
          return ok('uploaded\n');
        }
        case 'start': {
          const r = rs.get(op.runnerId);
          if (!r) return { code: 3, stdout: '', stderr: 'runner.js missing', truncated: false };
          if (!r.alive) {
            r.alive = true;
            r.startedAt = t;
            const id = r.trips.length;
            r.trips.push(
              JSON.stringify({
                id: `f${id}:0`,
                instrumentId: r.cfg.instrument.id,
                accountId: 'vps',
                side: 'long',
                qty: 1,
                entryPx: 649_900,
                exitPx: 650_000,
                entryTs: t - 60_000,
                exitTs: t - 1_000,
                pnl: 10,
                commission: 0.5,
              }),
            );
          }
          return ok('started\n');
        }
        case 'stop': {
          const r = rs.get(op.runnerId);
          if (r) r.alive = false;
          return ok(r ? 'stopped\n' : 'not-deployed\n');
        }
        case 'remove':
          rs.delete(op.runnerId);
          return ok('removed\n');
        case 'status': {
          let out = `@@now ${Math.floor(t / 1000)}\n`;
          for (const [id, r] of rs) {
            const logs = [
              {
                ts: r.startedAt,
                level: 'info',
                msg: `Runner ${id} started: ${r.cfg.strategyName}`,
              },
              { ts: t, level: 'info', msg: 'Connected to the public feed' },
            ].slice(-op.logLines);
            out += `@@runner ${id}\n@@alive ${r.alive ? 1 : 0}\n@@state\n${JSON.stringify(stateOf(r, t))}\n\n@@log\n`;
            out += logs.map((l) => JSON.stringify(l)).join('\n') + '\n@@end\n';
          }
          return ok(out);
        }
        case 'trips': {
          const r = rs.get(op.runnerId);
          return ok(r ? r.trips.slice(op.from, op.from + op.max).join('\n') + '\n' : '');
        }
        case 'logs':
          return ok('');
      }
    },
    exec: async (spec, command, onData) => {
      check(spec);
      onData('out', `$ ${command}\n`);
      onData('out', command.includes('node') ? 'v22.11.0\n' : 'ok\n');
      return 0;
    },
  };
}

declare global {
  interface Window {
    __HTFLOW_VPS_MOCK__?: boolean;
  }
}

let mock: VpsNative | null = null;
export function vpsNative(): VpsNative {
  if (isTauri) return tauriNative;
  if (typeof window !== 'undefined' && window.__HTFLOW_VPS_MOCK__)
    return (mock ??= createMockNative());
  return noneNative;
}
