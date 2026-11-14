import type { RoundTrip } from '@htflow/trading';
import type { LogLine, RunnerState } from './core';

/** Remote OS as reported by the native probe. */
export type RemoteOs = 'linux' | 'windows';
export type StartMode = 'nohup' | 'systemd-user' | 'scheduled-task';

export const MIN_NODE_MAJOR = 22;

export interface ProbeInfo {
  os: RemoteOs;
  osName: string;
  arch: string;
  /** `v22.11.0`, or null when Node.js is missing. */
  node: string | null;
  nodeOk: boolean;
  systemd: boolean;
  linger: 'yes' | 'no' | 'unknown';
  distro: string;
  home: string;
}

/** Parses the probe's `key=value` lines. */
export function parseProbe(os: RemoteOs, raw: string): ProbeInfo {
  const kv = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const nodeRaw = kv.get('node') ?? 'none';
  const node = /^v?\d+\.\d+/.test(nodeRaw)
    ? nodeRaw.startsWith('v')
      ? nodeRaw
      : `v${nodeRaw}`
    : null;
  const linger = kv.get('linger');
  return {
    os,
    osName: kv.get('os') ?? (os === 'windows' ? 'Windows' : 'Linux'),
    arch: kv.get('arch') ?? '',
    node,
    nodeOk: node !== null && nodeMajor(node) >= MIN_NODE_MAJOR,
    systemd: kv.get('systemd') === 'yes',
    linger: linger === 'yes' || linger === 'no' ? linger : 'unknown',
    distro: kv.get('distro') ?? 'unknown',
    home: kv.get('home') ?? '',
  };
}

export function nodeMajor(v: string): number {
  const m = /^v?(\d+)\./.exec(v.trim());
  return m ? Number(m[1]) : 0;
}

/** Start modes available on a system (first = default). */
export function startModes(p: Pick<ProbeInfo, 'os' | 'systemd'>): StartMode[] {
  if (p.os === 'windows') return ['scheduled-task'];
  return p.systemd ? ['systemd-user', 'nohup'] : ['nohup'];
}

export const START_MODE_LABEL: Record<StartMode, string> = {
  nohup: 'Background process (nohup) — stops on reboot',
  'systemd-user': 'systemd user service — restarts on failure / reboot',
  'scheduled-task': 'Scheduled task (per user) — restarts on failure / log-on',
};

/** Manual install steps shown when Node.js is missing or too old (never run as root by us). */
export function nodeInstallSteps(p: Pick<ProbeInfo, 'os' | 'distro'>): {
  title: string;
  commands: string[];
  note: string;
} {
  if (p.os === 'windows')
    return {
      title: 'Windows Server',
      commands: [
        'winget install OpenJS.NodeJS.LTS',
        '# or download the LTS .msi from nodejs.org and run it',
        'node --version',
      ],
      note: 'Run in an elevated PowerShell on the VPS, then open a new SSH session.',
    };
  return {
    title: /ubuntu|debian/i.test(p.distro) || p.distro === 'unknown' ? 'Ubuntu / Debian' : p.distro,
    commands: [
      'curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh',
      'sudo bash nodesource_setup.sh',
      'sudo apt-get install -y nodejs',
      'node --version',
      '# no sudo? per-user install: https://github.com/nvm-sh/nvm, then: nvm install 22',
    ],
    note: `Node.js ${MIN_NODE_MAJOR}+ is needed. HT Flow never installs software as root for you.`,
  };
}

/** One runner as seen by the status poll. */
export interface RemoteRunner {
  id: string;
  alive: boolean;
  state: RunnerState | null;
  logs: LogLine[];
}

export interface StatusReport {
  /** Server clock (ms), for uptime / staleness. */
  now: number;
  runners: RemoteRunner[];
}

function parseJson<T>(s: string): T | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Parses the `@@`-sectioned output of the status command (crates/vps commands::status). */
export function parseStatus(out: string): StatusReport {
  const rep: StatusReport = { now: Number.NaN, runners: [] };
  let cur: RemoteRunner | null = null;
  let section: 'state' | 'log' | null = null;
  let stateText = '';
  const close = () => {
    if (!cur) return;
    const st = parseJson<RunnerState>(stateText.trim());
    cur.state = st && typeof st.runnerId === 'string' ? st : null;
    rep.runners.push(cur);
    cur = null;
    section = null;
    stateText = '';
  };
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('@@now ')) rep.now = Number(line.slice(6)) * 1000;
    else if (line.startsWith('@@runner ')) {
      close();
      cur = { id: line.slice(9).trim(), alive: false, state: null, logs: [] };
    } else if (!cur) continue;
    else if (line.startsWith('@@alive ')) cur.alive = line.slice(8).trim() === '1';
    else if (line === '@@state') section = 'state';
    else if (line === '@@log') section = 'log';
    else if (line === '@@end') close();
    else if (section === 'state') stateText += line + '\n';
    else if (section === 'log' && line.trim()) {
      const l = parseJson<LogLine>(line);
      if (l && typeof l.msg === 'string') cur.logs.push(l);
    }
  }
  close();
  return rep;
}

export type RunnerHealth = 'running' | 'starting' | 'stale' | 'stopped' | 'error' | 'not-started';

/** Display status from process liveness + the state file's age. */
export function healthOf(r: RemoteRunner, now: number): RunnerHealth {
  const s = r.state;
  if (!s) return r.alive ? 'starting' : 'not-started';
  if (s.status === 'error') return 'error';
  if (!r.alive) return 'stopped';
  if (Number.isFinite(now) && now - s.updatedAt > 30_000) return 'stale';
  return s.status === 'running' ? 'running' : s.status === 'starting' ? 'starting' : 'stopped';
}

export function uptimeText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  return m ? `${m} m` : `${s} s`;
}

/** Journal account ids of VPS runners: `vps:<vpsId>`. */
export const VPS_ACCOUNT_PREFIX = 'vps:';
export const vpsAccountId = (vpsId: string) => `${VPS_ACCOUNT_PREFIX}${vpsId}`;
export const isVpsAccount = (id: string) => id.startsWith(VPS_ACCOUNT_PREFIX);

/**
 * Converts `trips.jsonl` lines into journal round trips under the VPS account. Ids are made
 * globally unique (`vps:<vps>:<runner>:<deployment>:<line>`) so re-imports are idempotent and
 * restarts (whose engine ids start over) never collide. Bad lines are skipped.
 */
export function importTrips(
  lines: readonly string[],
  ctx: { vpsId: string; runnerId: string; deployment: string; firstLine: number },
): RoundTrip[] {
  const out: RoundTrip[] = [];
  lines.forEach((line, k) => {
    if (!line.trim()) return;
    const t = parseJson<RoundTrip>(line);
    if (
      !t ||
      (t.side !== 'long' && t.side !== 'short') ||
      ![t.qty, t.entryPx, t.exitPx, t.entryTs, t.exitTs, t.pnl, t.commission].every(
        (x) => typeof x === 'number' && Number.isFinite(x),
      )
    )
      return;
    out.push({
      id: `vps:${ctx.vpsId}:${ctx.runnerId}:${ctx.deployment}:${ctx.firstLine + k}`,
      instrumentId: typeof t.instrumentId === 'string' ? t.instrumentId : 'unknown',
      accountId: vpsAccountId(ctx.vpsId),
      side: t.side,
      qty: t.qty,
      entryPx: t.entryPx,
      exitPx: t.exitPx,
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      pnl: t.pnl,
      commission: t.commission,
    });
  });
  return out;
}
