import type { RawInputs } from '@htflow/indicator-sdk';
import type { BarSpec } from '@htflow/market-data';
import type { StrategyInstrument } from '@htflow/strategy';
import type { RoundTrip } from '@htflow/trading';
import { buildRunnerBundle } from './bundle';
import { RUNNER_PROTOCOL, type FeedSpec, type RunnerConfig } from './core';
import type { ConnSpec, OpOutput, VpsNative } from './native';
import {
  importTrips,
  parseProbe,
  parseStatus,
  type ProbeInfo,
  type RemoteOs,
  type StartMode,
  type StatusReport,
} from './protocol';

/** A user-owned VPS (persisted in settings; secrets live in the vault). */
export interface VpsHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'key' | 'password';
  /** Pinned SHA-256 host key; empty only when the user turned pinning off. */
  fingerprint: string;
  pinHostKey: boolean;
  os?: RemoteOs;
  probe?: ProbeInfo;
  deployments: Deployment[];
}

export interface Deployment {
  runnerId: string;
  strategyId: string;
  strategyName: string;
  instrumentId: string;
  symbol: string;
  exchange: FeedSpec['exchange'];
  inputs: RawInputs;
  bars: BarSpec;
  maxPosition: number;
  startMode: StartMode;
  /** First deployment time (part of journal trip ids; kept across redeploys). */
  createdAt: number;
  deployedAt: number;
  sha256: string;
  bytes: number;
  /** Lines of trips.jsonl already imported into the journal. */
  importedLines: number;
}

export const HOSTS_KEY = 'strategies.vps.hosts';

export function sanitizeHosts(raw: unknown): VpsHost[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (h): h is VpsHost =>
        !!h &&
        typeof h === 'object' &&
        typeof (h as VpsHost).id === 'string' &&
        /^[a-z0-9-]{1,40}$/.test((h as VpsHost).id) &&
        typeof (h as VpsHost).host === 'string' &&
        typeof (h as VpsHost).user === 'string',
    )
    .map((h) => ({
      ...h,
      port: Number.isInteger(h.port) && h.port > 0 && h.port < 65536 ? h.port : 22,
      auth: h.auth === 'password' ? 'password' : 'key',
      fingerprint: typeof h.fingerprint === 'string' ? h.fingerprint : '',
      pinHostKey: h.pinHostKey !== false,
      deployments: Array.isArray(h.deployments)
        ? h.deployments.filter((d) => d && /^[a-z0-9-]{1,40}$/.test(d.runnerId))
        : [],
    }));
}

/** Client-side mirror of the native host check (the Rust side validates again). */
export function validHost(h: string): boolean {
  const s = h.trim().replace(/^\[|\]$/g, '');
  if (!s) return false;
  if (s.includes(':')) return /^[0-9a-f:.]+$/i.test(s);
  if (/^[\d.]+$/.test(s))
    return /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((x) => +x <= 255);
  return (
    s.length <= 253 && s.split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(l))
  );
}

export const validUser = (u: string) => /^[A-Za-z0-9._$\\-]{1,64}$/.test(u) && !u.startsWith('-');

export function specOf(h: VpsHost): ConnSpec {
  return {
    id: h.id,
    host: h.host,
    port: h.port,
    user: h.user,
    auth: h.auth,
    fingerprint: h.pinHostKey ? h.fingerprint || null : null,
    trustAnyHostKey: !h.pinHostKey,
  };
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/** `<strategy>-<symbol>[-n]`, unique on the host, valid as a folder / unit / task name. */
export function newRunnerId(strategyId: string, symbol: string, taken: readonly string[]): string {
  const base =
    `${slug(strategyId).slice(0, 18)}-${slug(symbol).slice(0, 14)}`.replace(/^-+/, '') || 'runner';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id.slice(0, 40);
}

export function makeRunnerConfig(a: {
  host: VpsHost;
  runnerId: string;
  strategyId: string;
  strategyName: string;
  inputs: RawInputs;
  instrument: StrategyInstrument;
  feed: FeedSpec;
  bars: BarSpec;
  maxPosition: number;
  startingBalance?: number;
  commissionPerUnit?: number;
  now?: number;
  script?: RunnerConfig['script'];
}): RunnerConfig {
  return {
    v: RUNNER_PROTOCOL,
    runnerId: a.runnerId,
    vpsId: a.host.id,
    strategyId: a.strategyId,
    strategyName: a.strategyName,
    inputs: a.inputs,
    instrument: a.instrument,
    feed: a.feed,
    bars: a.bars,
    account: {
      startingBalance: a.startingBalance ?? 50_000,
      commissionPerUnit: a.commissionPerUnit ?? 0,
      takerFee: 0,
    },
    maxPosition: a.maxPosition,
    deployedAt: a.now ?? Date.now(),
    ...(a.script ? { script: a.script } : {}),
  };
}

function must(o: OpOutput, what: string): OpOutput {
  if (o.code !== 0) {
    const msg = (o.stderr || o.stdout).trim().split('\n').slice(-3).join(' ');
    throw {
      code: 'vps.remote',
      message: `${what} failed (exit ${o.code ?? '?'}): ${msg || 'no output'}`,
    };
  }
  return o;
}

/** Probes the host (OS, Node.js, systemd). */
export async function probeHost(native: VpsNative, h: VpsHost): Promise<ProbeInfo> {
  const r = await native.probe(specOf(h));
  return parseProbe(r.os, r.raw);
}

/** Bundles, uploads and (re)starts a runner. Returns the bundle hash and size. */
export async function deployRunner(
  native: VpsNative,
  h: VpsHost,
  cfg: RunnerConfig,
  mode: StartMode,
  core: string,
  restart = true,
): Promise<{ sha256: string; bytes: number }> {
  if (!h.os) throw { code: 'vps.not_probed', message: 'Check the system first (Test connection)' };
  const b = await buildRunnerBundle(core, cfg);
  const spec = specOf(h);
  if (restart) await native.op(spec, h.os, { kind: 'stop', runnerId: cfg.runnerId });
  must(
    await native.op(spec, h.os, {
      kind: 'upload',
      runnerId: cfg.runnerId,
      file: 'runner.js',
      content: b.source,
    }),
    'Upload',
  );
  must(await native.op(spec, h.os, { kind: 'start', runnerId: cfg.runnerId, mode }), 'Start');
  return { sha256: b.sha256, bytes: b.bytes };
}

export async function runnerOp(
  native: VpsNative,
  h: VpsHost,
  kind: 'start' | 'stop' | 'remove',
  d: Deployment,
): Promise<void> {
  if (!h.os) throw { code: 'vps.not_probed', message: 'Check the system first (Test connection)' };
  const spec = specOf(h);
  const op =
    kind === 'start'
      ? ({ kind, runnerId: d.runnerId, mode: d.startMode } as const)
      : ({ kind, runnerId: d.runnerId } as const);
  must(await native.op(spec, h.os, op), kind[0]!.toUpperCase() + kind.slice(1));
}

export async function pollStatus(
  native: VpsNative,
  h: VpsHost,
  logLines = 8,
): Promise<StatusReport> {
  if (!h.os) throw { code: 'vps.not_probed', message: 'Check the system first (Test connection)' };
  const o = must(await native.op(specOf(h), h.os, { kind: 'status', logLines }), 'Status');
  return parseStatus(o.stdout);
}

/** New closed trips of a runner (from `importedLines`), ready for the journal. */
export async function pullTrips(
  native: VpsNative,
  h: VpsHost,
  d: Deployment,
  max = 1000,
): Promise<{ trips: RoundTrip[]; lines: number }> {
  if (!h.os) return { trips: [], lines: 0 };
  const o = must(
    await native.op(specOf(h), h.os, {
      kind: 'trips',
      runnerId: d.runnerId,
      from: d.importedLines,
      max,
    }),
    'Fetching fills',
  );
  const lines = o.stdout.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return {
    trips: importTrips(lines, {
      vpsId: h.id,
      runnerId: d.runnerId,
      deployment: d.createdAt.toString(36),
      firstLine: d.importedLines,
    }),
    lines: lines.length,
  };
}
