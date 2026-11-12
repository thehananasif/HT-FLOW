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

## VPS runner: planned local-runner protocol (BLOCKED)

Running strategies on a remote machine needs the headless **HT Flow Runner** binary (the Rust
core: connectors, event bus, strategy engine, risk engine). That binary is not built yet. The UI
(runner list, deploy dialog, status panel, kill switch) is in place and shows a
"requires your own VPS runner" banner. Planned protocol:

1. **Transport.** The desktop app opens an SSH connection (`russh`, key from the vault) and a
   local port forward to `127.0.0.1:47800` on the VPS. The runner listens only on loopback, so no
   port is open to the internet. Frames are length-prefixed JSON (later MessagePack):
   `u32 length | { "v": 1, "id": n, "type": ..., "body": ... }`.
2. **Handshake.** `hello { app_version, profile_id, nonce }` gets
   `hello_ok { runner_version, host, os, cpu, ram, uptime_s }`. The session token is an HMAC of
   the nonce with a per-runner secret stored in the vault at install time.
3. **Install.** `Install runner` uploads the signed runner binary over SFTP to
   `~/.htflow-runner/`, checks its signature, and registers a systemd user unit (on Linux) or a
   scheduled task (on Windows). It is idempotent.
4. **Deploy.** `deploy { bundle_id, strategy_id, source (bundled JS), inputs, instrument, account,
risk_rules, atm_templates }` gets `deployed { bundle_id }`. Bundles are content-addressed
   (SHA-256). The runner runs them in an embedded JS engine with the same `@htflow/strategy`
   API. Risk rules are enforced on the runner too.
5. **Control.** `start` / `stop { bundle_id }`, `flatten { bundle_id | "all" }`, and
   `kill { flatten: true }`. The kill switch stops every strategy and flattens every account.
6. **Streams** (runner to app, with a sequence number per stream): `fill`, `order`, `position`,
   `pnl` (1 s), `log`, `status { cpu, ram, ping_broker_ms, strategies[] }` (5 s).
7. **Resume.** On reconnect the app sends `resume { stream, last_seq }`, and the runner replays
   from its local journal (SQLite) so no fill is lost while the PC was off. Fills are mirrored
   into the Journal and Tables with the tag `vps:<runner>`.
8. **Acceptance (P42).** Deploy to a test VPS, disconnect the PC, let the strategy keep trading
   on paper, then reconnect: every fill appears in the Journal.

## Not built

- The Monaco code editor, `.ts` / `.py` / `.htstrat` file loading, and the embedded Python runner
  (Monaco would be a new dependency).
- The no-code rule builder.
- The runner binary and the SSH transport (see above).
