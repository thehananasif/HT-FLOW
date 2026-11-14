/**
 * Node.js entry of the headless VPS runner. Bundled (with the strategy SDK, every built-in
 * strategy, the paper engine and this file) into one `runner.js` by `apps/desktop/runnerBundle.ts`;
 * the deploy step prepends the runner's config. Needs Node.js 22+ (global WebSocket).
 *
 * Files in the working directory: state.json, log.jsonl, trips.jsonl, pid; a `stop` file asks
 * the runner to flatten and exit. SIGTERM / SIGINT do the same.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { HeadlessRunner, type RunnerConfig } from './core';
import { endpointFor, parseFrame } from './feeds';

declare const __HTFLOW_RUNNER_CONFIG__: RunnerConfig | undefined;

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotate(file: string): void {
  try {
    if (existsSync(file) && readFileSync(file).length > MAX_LOG_BYTES)
      renameSync(file, `${file}.1`);
  } catch {
    /* best effort */
  }
}

function countLines(file: string): number {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function main(): void {
  const cfg =
    typeof __HTFLOW_RUNNER_CONFIG__ === 'undefined' ? undefined : __HTFLOW_RUNNER_CONFIG__;
  if (!cfg) {
    console.error('runner.js has no configuration; redeploy it from HT Flow');
    process.exit(2);
  }
  const major = Number(process.versions.node.split('.')[0]);
  const selftest = process.env.HTFLOW_RUNNER_SELFTEST === '1';
  if (!selftest && (major < 22 || typeof WebSocket === 'undefined')) {
    console.error(`Node.js 22 or newer is required (found ${process.versions.node})`);
    process.exit(3);
  }
  rotate('log.jsonl');
  try {
    unlinkSync('stop');
  } catch {
    /* none */
  }
  writeFileSync('pid', String(process.pid));
  const r = new HeadlessRunner(
    cfg,
    {
      writeState: (json) => {
        writeFileSync('state.json.tmp', json);
        renameSync('state.json.tmp', 'state.json');
      },
      appendLog: (line) => appendFileSync('log.jsonl', line + '\n'),
      appendTrip: (line) => appendFileSync('trips.jsonl', line + '\n'),
    },
    { pid: process.pid, tripsDone: countLines('trips.jsonl') },
  );
  r.log(
    'info',
    `Runner ${cfg.runnerId} started: ${cfg.strategyName} on ${cfg.feed.exchange} ${cfg.feed.symbol} (paper)`,
  );
  r.flush();

  let done = false;
  let ws: WebSocket | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];
  const finish = (reason: string, code = 0) => {
    if (done) return;
    done = true;
    for (const t of timers) clearInterval(t);
    try {
      ws?.close();
    } catch {
      /* closing */
    }
    r.stop(reason);
    process.exit(code);
  };
  process.on('SIGTERM', () => finish('SIGTERM'));
  process.on('SIGINT', () => finish('SIGINT'));
  process.on('uncaughtException', (e) => {
    r.fail(`Crash: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
  timers.push(
    setInterval(() => {
      r.flush();
      if (existsSync('stop')) finish('stop requested');
    }, 2000),
  );

  if (selftest) {
    // Offline check used by the tests: a synthetic tape, then a clean stop.
    const t0 = Date.UTC(2026, 0, 5, 14, 30);
    r.setFeed(true, 'Self-test feed');
    for (let i = 0; i < 4000; i++) {
      const px = 1000 + Math.round(20 * Math.sin(i / 60) + (i % 7) - 3);
      r.onTrade({ ts: t0 + i * 1500, px, qty: 1 + (i % 5), side: i % 3 ? 'buy' : 'sell', id: i });
    }
    finish('self-test complete');
    return;
  }

  const ep = endpointFor(cfg.feed);
  let backoff = 1000;
  const connect = () => {
    if (done) return;
    const sock = new WebSocket(ep.url);
    ws = sock;
    let pinger: ReturnType<typeof setInterval> | null = null;
    let last = Date.now();
    sock.onopen = () => {
      backoff = 1000;
      if (ep.subscribe) sock.send(ep.subscribe);
      r.setFeed(true, `Connected to ${ep.url}`);
      pinger = setInterval(() => {
        if (Date.now() - last > 60_000) sock.close();
        else if (ep.ping) sock.send(ep.ping.text);
      }, ep.ping?.everyMs ?? 20_000);
    };
    sock.onmessage = (ev: MessageEvent) => {
      last = Date.now();
      if (typeof ev.data !== 'string') return;
      try {
        for (const t of parseFrame(cfg.feed.exchange, ev.data, cfg.instrument.tickSize))
          r.onTrade(t);
      } catch (e) {
        r.fail(`Strategy error: ${e instanceof Error ? e.message : String(e)}`);
        finish('strategy error', 1);
      }
    };
    sock.onclose = () => {
      if (pinger) clearInterval(pinger);
      if (done) return;
      r.setFeed(false, `Feed closed; reconnecting in ${Math.round(backoff / 1000)} s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  };
  connect();
}

main();
