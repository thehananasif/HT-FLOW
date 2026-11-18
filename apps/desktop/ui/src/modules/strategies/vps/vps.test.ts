import { describe, expect, it } from 'vitest';
import { asAnyStrategy, defineStrategy, registerStrategy } from '@htflow/strategy';
import { bundleHeader, buildRunnerBundle, jsLiteral, sha256Hex } from './bundle';
import { HeadlessRunner, type RunnerConfig, type RunnerState } from './core';
import { compileProject } from '../editor/compile';
import { endpointFor, feedForInstrument, parseFrame } from './feeds';
import { createMockNative, MOCK_FINGERPRINT } from './native';
import {
  healthOf,
  importTrips,
  nodeInstallSteps,
  parseProbe,
  parseStatus,
  startModes,
  uptimeText,
} from './protocol';
import {
  deployRunner,
  makeRunnerConfig,
  newRunnerId,
  pollStatus,
  probeHost,
  pullTrips,
  runnerOp,
  sanitizeHosts,
  specOf,
  validHost,
  type VpsHost,
} from './service';

// A strategy that alternates long / flat every closed 5-trade bar (deterministic trips).
registerStrategy(
  asAnyStrategy(
    defineStrategy({
      id: 'vps-test-flip',
      name: 'VPS test flip',
      category: 'custom',
      description: 'test',
      bars: { kind: 'tick', n: 5 },
      inputs: {},
      onBar(ctx) {
        if (ctx.position.side === 'flat') ctx.buy(1);
        else ctx.flatten('flip');
      },
    }),
  ),
);

const host: VpsHost = {
  id: 'vps-a',
  name: 'Test VPS',
  host: 'vps.example.com',
  port: 22,
  user: 'trader',
  auth: 'key',
  fingerprint: MOCK_FINGERPRINT,
  pinHostKey: true,
  deployments: [],
};

function cfg(strategyId = 'vps-test-flip', maxPosition = 5): RunnerConfig {
  return makeRunnerConfig({
    host,
    runnerId: 'flip-btcusdt',
    strategyId,
    strategyName: 'VPS test flip',
    inputs: {},
    instrument: {
      id: 'binance-futures:BTCUSDT',
      symbol: 'BTCUSDT',
      tickSize: 0.1,
      tickValue: 0,
      pricePrecision: 1,
    },
    feed: { exchange: 'binance-futures', symbol: 'BTCUSDT' },
    bars: { kind: 'tick', n: 5 },
    maxPosition,
    now: 1_000,
  });
}

function io() {
  const out = { state: '', logs: [] as string[], trips: [] as string[] };
  return {
    out,
    io: {
      writeState: (j: string) => (out.state = j),
      appendLog: (l: string) => out.logs.push(l),
      appendTrip: (l: string) => out.trips.push(l),
    },
  };
}

describe('headless runner core', () => {
  it('trades paper on a tape, writes trips, state and stops flat', () => {
    const { out, io: sink } = io();
    const r = new HeadlessRunner(cfg(), sink, { pid: 7, now: 0 });
    r.setFeed(true);
    for (let i = 0; i < 60; i++)
      r.onTrade({
        ts: 1000 + i * 1000,
        px: 650_000 + (i % 10),
        qty: 1,
        side: i % 2 ? 'buy' : 'sell',
        id: i,
      });
    expect(out.trips.length).toBeGreaterThan(2);
    const trip = JSON.parse(out.trips[0]!);
    expect(trip.side).toBe('long');
    r.stop('test');
    const st = JSON.parse(out.state) as RunnerState;
    expect(st.status).toBe('stopped');
    expect(st.pid).toBe(7);
    expect(st.position.qty).toBe(0);
    expect(st.trips).toBe(out.trips.length);
    expect(st.feed.trades).toBe(60);
    expect(out.logs.some((l) => JSON.parse(l).msg.includes('Stopped'))).toBe(true);
  });

  it('enforces the risk cap', () => {
    const { out, io: sink } = io();
    const r = new HeadlessRunner(cfg('vps-test-flip', 0.5), sink);
    for (let i = 0; i < 20; i++) r.onTrade({ ts: i, px: 100, qty: 1, side: 'buy', id: i });
    const st = JSON.parse(out.state) as RunnerState;
    expect(st.status).toBe('error');
    expect(st.error).toMatch(/Risk cap/);
  });

  it('runs an HT Editor script in-process behind the bridge', () => {
    const c = compileProject([
      {
        name: 'strategy.ts',
        source: `export const meta = { name: 'Flip', timeframe: '5t' };
export function onBar(bar: Bar) {
  if (position().side === 'flat') buy(1, { label: 'in' });
  else close('out');
}`,
      },
    ]);
    const { out, io: sink } = io();
    const r = new HeadlessRunner(
      { ...cfg('script:x'), script: { project: c.project!, params: {} } },
      sink,
    );
    for (let i = 0; i < 60; i++)
      r.onTrade({
        ts: 1000 + i * 1000,
        px: 650_000 + (i % 7),
        qty: 1,
        side: i % 2 ? 'buy' : 'sell',
        id: i,
      });
    expect(r.bridge).not.toBeNull();
    expect(out.trips.length).toBeGreaterThan(2);
    r.stop('test');
    expect((JSON.parse(out.state) as RunnerState).position.qty).toBe(0);
  });

  it('rejects unknown strategies', () => {
    expect(() => new HeadlessRunner(cfg('nope'), io().io)).toThrow(/Unknown strategy/);
  });
});

describe('feeds', () => {
  it('maps instruments to public feeds', () => {
    expect(feedForInstrument('binance-futures:BTCUSDT')).toEqual({
      exchange: 'binance-futures',
      symbol: 'BTCUSDT',
    });
    expect(feedForInstrument('okx-swap:BTC-USDT-SWAP')).toEqual({
      exchange: 'okx',
      symbol: 'BTC-USDT-SWAP',
    });
    expect(feedForInstrument('mock:ESZ6')).toBeNull();
    expect(feedForInstrument('binance-spot:bad sym')).toBeNull();
    expect(endpointFor({ exchange: 'binance-spot', symbol: 'ETHUSDT' }).url).toContain(
      'ethusdt@aggTrade',
    );
    expect(endpointFor({ exchange: 'bybit-linear', symbol: 'BTCUSDT' }).subscribe).toContain(
      'publicTrade.BTCUSDT',
    );
  });

  it('parses trade frames into ticks', () => {
    const b = parseFrame(
      'binance-futures',
      '{"e":"aggTrade","a":5,"p":"65000.10","q":"0.5","T":1700,"m":true}',
      0.1,
    );
    expect(b).toEqual([{ ts: 1700, px: 650001, qty: 0.5, side: 'sell', id: 5 }]);
    const y = parseFrame(
      'bybit-linear',
      '{"topic":"publicTrade.BTCUSDT","data":[{"T":1,"S":"Buy","v":"2","p":"10.5","i":"x"}]}',
      0.5,
    );
    expect(y).toEqual([{ ts: 1, px: 21, qty: 2, side: 'buy', id: 0 }]);
    const o = parseFrame(
      'okx',
      '{"arg":{"channel":"trades"},"data":[{"px":"3","sz":"1","side":"sell","ts":"9","tradeId":"4"}]}',
      1,
    );
    expect(o).toEqual([{ ts: 9, px: 3, qty: 1, side: 'sell', id: 4 }]);
    expect(parseFrame('okx', 'pong', 1)).toEqual([]);
    expect(parseFrame('binance-spot', '{"result":null}', 1)).toEqual([]);
  });
});

describe('bundle', () => {
  it('prepends a safe config header and hashes the file', async () => {
    const c = { ...cfg(), strategyName: 'x</script>\u2028y' };
    expect(jsLiteral(c)).not.toContain('</script>');
    expect(jsLiteral('\u2028')).toBe('"\\u2028"');
    const h = bundleHeader(c);
    expect(h).toContain('globalThis.__HTFLOW_RUNNER_CONFIG__ = ');
    expect(h.split('\n')[1]).not.toContain('\u2028');
    const b = await buildRunnerBundle('console.log(1);\n', c);
    expect(b.source.endsWith('console.log(1);\n')).toBe(true);
    expect(b.sha256).toBe(await sha256Hex(b.source));
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(buildRunnerBundle('  ', c)).rejects.toThrow();
  });

  it('builds a self-contained runner.js that runs under Node (self-test, no network)', async () => {
    const { buildRunnerCore } = await import('../../../../../runnerBundle');
    const core = await buildRunnerCore(true);
    expect(core).not.toMatch(/require\(["']@htflow\//);
    const b = await buildRunnerBundle(core, cfg('opening-range-breakout'));
    const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } =
      await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'htflow-runner-'));
    try {
      writeFileSync(join(dir, 'runner.js'), b.source);
      execFileSync(process.execPath, ['runner.js'], {
        cwd: dir,
        env: { ...process.env, HTFLOW_RUNNER_SELFTEST: '1' },
        timeout: 60_000,
      });
      const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RunnerState;
      expect(st.status).toBe('stopped');
      expect(st.feed.trades).toBe(4000);
      expect(st.position.qty).toBe(0);
      expect(existsSync(join(dir, 'pid'))).toBe(true);
      expect(readFileSync(join(dir, 'log.jsonl'), 'utf8')).toContain('self-test complete');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('protocol parsing', () => {
  it('parses probes and suggests start modes / install steps', () => {
    const p = parseProbe(
      'linux',
      'os=Linux\narch=x86_64\nnode=v20.11.1\nsystemd=yes\nlinger=no\ndistro=ubuntu\nhome=/home/t\n',
    );
    expect(p).toMatchObject({
      osName: 'Linux',
      node: 'v20.11.1',
      nodeOk: false,
      systemd: true,
      linger: 'no',
    });
    expect(startModes(p)).toEqual(['systemd-user', 'nohup']);
    expect(nodeInstallSteps(p).commands.join('\n')).toContain('setup_22.x');
    const w = parseProbe('windows', 'os=Windows\r\narch=AMD64\r\nnode=v22.3.0\r\n');
    expect(w.nodeOk).toBe(true);
    expect(startModes(w)).toEqual(['scheduled-task']);
    expect(nodeInstallSteps(w).commands[0]).toContain('winget');
    expect(parseProbe('linux', 'node=none').node).toBeNull();
  });

  it('parses status output (sections, broken JSON, CRLF)', () => {
    const state = { runnerId: 'a', status: 'running', updatedAt: 99_000, startedAt: 0 };
    const out = [
      '@@now 100',
      '@@runner a',
      '@@alive 1',
      '@@state',
      JSON.stringify(state),
      '',
      '@@log',
      '{"ts":1,"level":"info","msg":"hello"}',
      'not json',
      '@@end',
      '@@runner b',
      '@@alive 0',
      '@@state',
      '{broken',
      '@@log',
      '@@end',
    ].join('\r\n');
    const r = parseStatus(out);
    expect(r.now).toBe(100_000);
    expect(r.runners.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.runners[0]!.logs).toHaveLength(1);
    expect(healthOf(r.runners[0]!, r.now)).toBe('running');
    expect(healthOf(r.runners[0]!, 200_000)).toBe('stale');
    expect(r.runners[1]!.state).toBeNull();
    expect(healthOf(r.runners[1]!, r.now)).toBe('not-started');
    expect(parseStatus('').runners).toEqual([]);
    expect(uptimeText(90_061_000)).toBe('1 d 1 h');
    expect(uptimeText(5_000)).toBe('5 s');
  });

  it('imports trips into the VPS journal account idempotently', () => {
    const good = JSON.stringify({
      id: 'f1:0',
      instrumentId: 'binance-futures:BTCUSDT',
      side: 'short',
      qty: 2,
      entryPx: 10,
      exitPx: 8,
      entryTs: 1,
      exitTs: 2,
      pnl: 4,
      commission: 1,
    });
    const t = importTrips([good, 'garbage', '', JSON.stringify({ side: 'up' })], {
      vpsId: 'vps-a',
      runnerId: 'r1',
      deployment: 'k',
      firstLine: 10,
    });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      id: 'vps:vps-a:r1:k:10',
      accountId: 'vps:vps-a',
      side: 'short',
      pnl: 4,
    });
  });
});

describe('service against the mock VPS', () => {
  it('host helpers', () => {
    expect(
      validHost('vps.example.com') && validHost('203.0.113.4') && validHost('[2001:db8::1]'),
    ).toBe(true);
    expect(validHost('999.1.1.1') || validHost('bad_host') || validHost('')).toBe(false);
    expect(
      newRunnerId('opening-range-breakout', 'BTC-USDT-SWAP', ['opening-range-brea-btc-usdt-swap']),
    ).toBe('opening-range-brea-btc-usdt-swap-2');
    expect(sanitizeHosts([{ id: 'BAD' }, { ...host, port: 0 }])[0]!.port).toBe(22);
    expect(specOf({ ...host, pinHostKey: false })).toMatchObject({
      fingerprint: null,
      trustAnyHostKey: true,
    });
  });

  it('probe, deploy, poll, pull trips, stop, remove', async () => {
    let now = 1_000_000;
    const n = createMockNative(() => now);
    const h: VpsHost = { ...host, deployments: [] };
    const p = await probeHost(n, h);
    expect(p.nodeOk).toBe(true);
    h.os = p.os;
    const c = cfg();
    const res = await deployRunner(n, h, c, 'systemd-user', 'module.exports = 1;\n');
    expect(res.sha256).toHaveLength(64);
    now += 65_000;
    const st = await pollStatus(n, h);
    expect(st.runners[0]!.alive).toBe(true);
    expect(healthOf(st.runners[0]!, st.now)).toBe('running');
    const d = {
      runnerId: c.runnerId,
      strategyId: c.strategyId,
      strategyName: c.strategyName,
      instrumentId: c.instrument.id,
      symbol: 'BTCUSDT',
      exchange: 'binance-futures' as const,
      inputs: {},
      bars: c.bars,
      maxPosition: 5,
      startMode: 'systemd-user' as const,
      createdAt: 1,
      deployedAt: 1,
      sha256: res.sha256,
      bytes: res.bytes,
      importedLines: 0,
    };
    const pulled = await pullTrips(n, h, d);
    expect(pulled.lines).toBe(1);
    expect(pulled.trips[0]!.accountId).toBe('vps:vps-a');
    expect((await pullTrips(n, h, { ...d, importedLines: 1 })).trips).toHaveLength(0);
    await runnerOp(n, h, 'stop', d);
    expect((await pollStatus(n, h)).runners[0]!.alive).toBe(false);
    await runnerOp(n, h, 'remove', d);
    expect((await pollStatus(n, h)).runners).toHaveLength(0);
    await expect(n.connect(specOf({ ...h, fingerprint: 'SHA256:other' }))).rejects.toMatchObject({
      code: 'vps.host_key_mismatch',
    });
    await expect(pollStatus(n, { ...h, os: undefined })).rejects.toMatchObject({
      code: 'vps.not_probed',
    });
  });
});
