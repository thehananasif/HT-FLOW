# Strategies (P28 chart strategies, P42 strategies + VPS runner)

Code lives in two places:

- `packages/strategy` (pure TS): `defineStrategy` SDK, `StrategyRunner`, the deterministic
  `Backtest`, the metrics, the grid `Optimizer`, `WalkForward`, and five example strategies.
- `apps/desktop/ui/src/modules/strategies`: the Strategies window, the chart extension (markers,
  live paper runs, journal snapshots), the optimiser Web Worker and the VPS runner UI.

## Writing a strategy

```ts
import { defineStrategy, input } from '@htflow/strategy';

export const MyStrategy = defineStrategy({
  id: 'my-strategy',
  name: 'My strategy',
  category: 'custom',
  description: 'Buys strong positive-delta bars above VWAP.',
  bars: { kind: 'time', ms: 300_000 },
  inputs: {
    minDelta: input.float('Min delta', 200, { min: 0, max: 1e6 }),
    stop: input.int('Stop', 12, { min: 1, max: 500, unit: 'ticks' }),
  },
  onBar(ctx) {
    const vwap = ctx.indicator('vwap').value('vwap');
    if (ctx.position.side === 'flat' && ctx.bar.delta > ctx.inputs.minDelta && ctx.bar.c > vwap)
      ctx.buy(1, { bracket: { stopTicks: ctx.inputs.stop, targetTicks: 2 * ctx.inputs.stop } });
  },
});
```

Hooks: `onBar` (closed bar), `onTrade`, `onBook`, `onFill`. The context gives bars with
footprint clusters, `cvd`, `poc()`, `imbalances()`, `stackedImbalances()`, any indicator from
`@htflow/indicators` by id, the position, and the order API: market / limit / stop / MIT /
trailing-stop, brackets (`stopTicks`, `targetTicks` (one or more), `trailTicks`), ATM templates
(`opts.atm`), `cancel`, `cancelAll`, `flatten`, `qtyForRisk`, `log`. Prices are integer ticks.

`registerStrategy(def)` adds a strategy to the list. Workers look strategies up by id, so a
strategy that should be optimised in the worker must be registered in a module the worker
imports (the built-ins are).

## Backtests

`runBacktest(def, inputs, dataset, config)` replays trades, and the recorded book when there is
one, through a private `PaperEngine`. Market and stop orders walk the book shifted by
`slippageTicks`. Resting limits fill when the tape trades through them. Commission is per
contract per side, plus an optional taker fee. Order ids are renumbered, so two runs on the same
data give identical results, whatever the chunking (`Backtest.step(budgetMs)`).

History comes from the replay data source registry (`feeds/replay.ts`): the tick store when it
covers the instrument, otherwise the simulator (deterministic per UTC day) or session memory.

## VPS runner (your own VPS, over SSH, paper only)

No HT Flow server is involved: the desktop app talks to the user's VPS directly over SSH, and the
runner on the VPS talks only to public exchange market data.

**Code.** `crates/vps` (Rust: `russh` SSH client, host / key parsing, host-key pinning, remote
command builder), `src-tauri/src/vps_cmds.rs` (Tauri `vps_*` commands, pooled sessions, vault
access), `vps/` here (TS: `core.ts` headless runner, `feeds.ts` public trade streams, `main.ts` Node
entry, `bundle.ts` deploy bundle, `protocol.ts` parsers, `service.ts` orchestration, `native.ts`
Tauri bridge + in-memory mock, `panel.tsx` UI) and `apps/desktop/runnerBundle.ts` (Vite plugin).

1. **Connection.** A VPS is `{ host, port, user, auth: key | password, fingerprint }` in settings.
   Secrets live only in the encrypted vault under fixed keys `vps/<id>/key`, `vps/<id>/passphrase`
   and `vps/<id>/password`; the Rust side reads them when it opens a session, so they never come
   back to the UI. Host keys are pinned (`SHA256:<base64>`, as `ssh-keygen -lf` prints): on Add,
   `vps_host_key` reads the server key without logging in and the user confirms it
   (trust on first use). A changed key refuses the connection (`vps.host_key_mismatch`). Pinning
   can be turned off explicitly (warning shown). Timeouts: connect 12 s, auth 20 s, commands
   30–180 s, keep-alive 15 s × 3. Sessions are pooled per VPS and dropped on transport errors.
2. **Probe.** `vps_probe` runs a POSIX probe (`uname`, `node --version`, systemd user manager,
   lingering, distro) and falls back to a PowerShell probe for Windows. Node.js 22+ is required
   (global `WebSocket`); if missing, the UI shows manual install steps (Ubuntu / Debian via
   NodeSource or nvm, Windows Server via winget). HT Flow never installs software as root.
3. **Deploy.** `runner.js` = a config header
   (`globalThis.__HTFLOW_RUNNER_CONFIG__ = { runnerId, strategyId, inputs, instrument, feed, bars,
account, maxPosition }`) + the prebuilt runner core (CommonJS for Node 22, ~240 KB: the
   `@htflow/strategy` SDK, every built-in strategy, the `PaperEngine`, `core.ts`, `main.ts`), built
   by Vite and imported lazily as `virtual:htflow-vps-runner`. The bundle id is its SHA-256. It is
   uploaded over the exec channel's stdin (atomic `.part` + rename, mode 600; base64 through
   PowerShell on Windows) to `~/.htflow-runner/runners/<runnerId>/`.
4. **Start / stop.** Linux: `nohup node runner.js` or a systemd **user** unit
   `htflow-runner-<id>.service` (`Restart=on-failure`; survives reboots with
   `loginctl enable-linger`). Windows: per-user scheduled task `HTFlowRunner-<id>` (at log-on,
   restart on failure). Stop writes a `stop` file: the runner flattens its paper position, writes
   its last trips and state and exits; after 8 s it is killed. Remove also deletes the folder,
   unit and task. Everything runs as the SSH user, never root.
5. **Runner.** `main.ts` connects to the public trade stream (Binance Futures / Spot `aggTrade`,
   Bybit `publicTrade`, OKX `trades`) with exponential back-off, feeds every trade to the
   `PaperEngine` (fills against a tape-derived top of book, like the backtester) and to the
   `StrategyRunner`. A risk cap (`maxPosition`) flattens and stops the runner. Files:
   `state.json` (every 2 s), `log.jsonl` (rotated at 5 MB), `trips.jsonl` (closed round trips),
   `pid`. Restarts start flat (paper).
6. **Monitor.** Every 10 s while the tab is open, one `status` command returns
   `@@now`, then per runner `@@runner`, `@@alive`, `@@state` + state.json, `@@log` + the last log
   lines, `@@end` (`parseStatus`). A runner whose state is older than 30 s while its process lives
   shows "No heartbeat".
7. **Journal.** `trips` reads `trips.jsonl` from the last imported line; trips are imported with
   ids `vps:<vps>:<runner>:<deployment>:<line>` (idempotent) into the account `vps:<vps>`, shown
   as **VPS** in the Journal's account filter, tagged `vps`.
8. **Not done.** Live order routing from the VPS needs a broker connector (see BLOCKERS). Only
   built-in strategies are bundled (user-registered strategies are not yet).

## Not built

- The Monaco code editor, `.ts` / `.py` / `.htstrat` file loading, and the embedded Python runner
  (Monaco would be a new dependency).
- The no-code rule builder.
