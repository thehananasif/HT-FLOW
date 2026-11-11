# Agent guide — building HT Flow in parallel

Read `docs/ARCHITECTURE.md` and the master spec section for your phase first. This file lists the
conventions and extension points that let several agents work at once without editing the same files.

## Commands

```bash
pnpm install                 # first thing in a fresh worktree
pnpm typecheck && pnpm lint  # TS strict + ESLint
pnpm test                    # Vitest (all packages + UI)
pnpm format                  # Prettier (run before committing)
pnpm dev:web                 # UI in a browser at http://localhost:1420 (no Rust needed)
E2E_PORT=<your port> pnpm e2e  # Playwright (each agent uses its own port)
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

`cargo` commands that compile `apps/desktop/src-tauri` need `apps/desktop/dist` to exist: run `pnpm build:web` once first.

## Extension points (use these instead of editing shared files)

| Need                                                        | Use                                                                                                                                                                                                                                                                                                                   | File                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A new window (ribbon module)                                | Create `apps/desktop/ui/src/modules/<name>/index.tsx` that calls `registerModule({ id, view })`. It is auto-loaded. `id` must match a ribbon id in `shell/modules.ts` (or pass `label` for a new one). The view gets `{ windowId, state, setParams }`; persist UI state through `setParams` (saved in the workspace). | `ui/src/modules/registry.ts`                         |
| A new data source (connector, replay, …)                    | Create `apps/desktop/ui/src/feeds/<name>.ts` that calls `registerFeedProvider({ prefix, label, instruments, create })`. Instrument ids start with the prefix (`replay:CLZ6`, `bybit-linear:BTCUSDT`). Auto-loaded.                                                                                                    | `ui/src/feeds/registry.ts`                           |
| Layers / interactions on every chart (indicators, drawings) | `registerChartExtension({ id, layers(ctx), attach(ctx), menu(ctx, px), Overlay })`. Data you save with `ctx.setExt(value)` lands in `ChartWindowState.ext[id]` and is persisted.                                                                                                                                      | `ui/src/charts/extensions.ts`                        |
| A control in every chart window header                      | `registerHeaderItem({ id, order, Component })`                                                                                                                                                                                                                                                                        | same                                                 |
| Mouse / keyboard interaction on a chart                     | push a `PointerHandler` onto `core.pointerHandlers` in `attach(ctx)` (return a disposer that removes it). `onDown` returning true captures the pointer and suppresses panning.                                                                                                                                        | `packages/chart-engine/src/chartCore.ts`             |
| A sub-pane under the price pane                             | a `ChartLayer` with `bottomHeight()`; each such layer gets its own stacked `v.bottom` rect.                                                                                                                                                                                                                           | same                                                 |
| Commands, hotkeys, Command Palette entries                  | `registerCommands([...])` (call at module import time or in an effect).                                                                                                                                                                                                                                               | `ui/src/shell/commands.ts`                           |
| Per-user persistence                                        | `backend.loadSettings<T>(key)` / `backend.saveSettings(key, value)` (encrypted per profile). Use a key prefixed with your module id.                                                                                                                                                                                  | `ui/src/backend`                                     |
| Market data for any instrument                              | `hub.retain(id)` / `hub.release(id)` or the `useMarketStore(id)` hook; `store.book`, `store.trades`, `store.depth`, `store.getSeries(spec)`, `store.onTrades(fn)`, `store.subscribe(fn)`.                                                                                                                             | `packages/market-data`, `ui/src/charts/useMarket.ts` |
| Paper trading                                               | `paper` (PaperEngine) and `PAPER_ACCOUNT` from `ui/src/state/market.ts`.                                                                                                                                                                                                                                              | `packages/trading`                                   |
| Strings                                                     | `t(key)` from `@htflow/i18n` for user-facing strings you add (add keys in `packages/i18n/src/en.ts` — append only, at the end).                                                                                                                                                                                       |                                                      |

## Rules

1. **Stay in your lane.** Only edit the files your task owns (listed in your brief). If you truly need a change in a shared file, keep it to the smallest possible hunk and mention it in your final report.
2. **Do not edit** `docs/FEATURES.md` or `docs/CHANGELOG.md` — the coordinator updates them from your final report.
3. **CSS** goes in a file next to your code (e.g. `modules/<name>/styles.css`, imported by your `index.tsx`), using the `--ht-*` tokens. Do not edit `ui/src/styles/app.css`.
4. **New npm dependencies:** avoid them. If one is essential it must be MIT/Apache/BSD/ISC, and you add it only to the package that needs it (`pnpm --filter <pkg> add <dep>`). New workspace packages under `packages/` are fine (`"main": "src/index.ts"`, no build step).
5. **Design system:** monochrome chrome, white is the only accent, colour only for market meaning (`up` green, `down` red, `warning` amber, `info` blue, `special` purple). Numbers use tabular figures (`.tnum`). Dense tables 11–12 px, rows 20–24 px, radius 4/8/10. Reuse `@htflow/ui-kit` components.
6. **Every setting** has a default, validation, and is persisted (workspace `ext`/`params`, or `backend.saveSettings`).
7. **Tests:** pure logic gets Vitest tests next to it (`*.test.ts`). Rust gets `#[cfg(test)]` tests. Add a Playwright test in `apps/desktop/e2e/<name>.spec.ts` for your main window if practical.
8. **Before you finish:** `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (and the cargo checks if you touched Rust) must all pass. Then commit on your branch with a clear message. Do **not** push.
9. **Final report:** list what you built (mapped to spec phases/bullets), what is tested, what is left or blocked and why, and any shared file you had to touch.
