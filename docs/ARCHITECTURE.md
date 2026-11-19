# Architecture

HT Flow is a Windows desktop app: a Rust core inside a Tauri 2 shell, with a React + TypeScript UI rendered by WebView2. Everything runs on the user's PC — no server, no paid APIs.

## Repository layout

```
apps/desktop/            Tauri app
  src-tauri/             Rust shell: IPC commands, data root, UI streamer
  ui/                    React UI (Vite root)
  e2e/                   Playwright tests (run against the browser build)
crates/
  core-types/            Normalised events, exact decimal → tick conversion, aggressor rule
  vault/                 XChaCha20-Poly1305 sealed blobs + encrypted key/value files
  auth/                  Local accounts: Argon2id key wrapping, recovery code, PIN, export/import
  connectors/binance/    Binance USDⓈ-M Futures public data (WebSocket + REST)
packages/
  ui-kit/                Design tokens, themes, fonts, React components
  market-data/           FeedSource interface, MockFeed simulator, OrderBook, BarSeries aggregator,
                         volume profile, MarketStore / MarketHub
  chart-engine/          ChartCore (scales, pan/zoom, crosshair, axes) + generic layers
  footprint/             Footprint modes, row merging, imbalances, footprint layer + gutters
  heatmap/               Liquidity map layer, gradients
  dom/                   DOM model + canvas ladder
  trading/               Order model, paper engine, journal statistics
  workspace/             Window state, layout presets, workspace document
  i18n/                  Localised strings (English)
docs/                    FEATURES, BLOCKERS, CHANGELOG, ARCHITECTURE, USER_GUIDE
```

TypeScript packages are source-only (`main: src/index.ts`) and bundled by Vite; there is no separate build step per package.

## Data flow (Live Pipeline)

```
Binance WS ──► connectors/binance (Rust)          MockFeed (TS, seeded)
  stage 1 connect / reconnect                        │
  stage 2 normalise → integer ticks                  │
  stage 3 BookSync (U/u/pu) → L2 book                │
        │ mpsc (bounded; lagging consumer → snapshot) │
  stage 9 UI streamer: 16 ms batches over a Tauri Channel
        ▼                                            ▼
   TauriLiveFeed ──────────────► FeedSource ◄──────── MockFeed
                                     │
                             MarketHub (one store per instrument, ref-counted)
                                     │
                             MarketStore: OrderBook, trades, depth columns (250 ms),
                                          shared BarSeries per bar type (stage 7)
                       ┌─────────────┼─────────────────┬──────────────────┐
                   ChartCore     DOM ladder       PaperEngine (stage 11)   tables
                   + layers      (canvas)         fills vs book + tape
```

- **Prices are integer ticks** everywhere after normalisation. Rust parses venue decimal strings exactly (`TickSize::parse_ticks`), never through `f64`.
- **One feed per instrument.** Every window that shows an instrument shares the same `MarketStore`; two charts with the same bar type share one `BarSeries`.
- **Same interface for mock and live.** `FeedSource` (`history()`, `subscribe()`, `start()`) is implemented by `MockFeed` and `TauriLiveFeed`. Components never know which one they use.

## Bar types (P07)

All bar types use the same per-trade state machine (`BarSeries.push`) for history and live, so a bulk build and any chunked incremental build are identical (property-tested for every preset, through `add`, `addAll` and the typed-array `addColumns` path). Prices are integer ticks.

| Type                       | Rule                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time                       | Bar open = `floor(ts / period) * period` (UTC aligned). Empty periods produce no bar. With a session, daily bars open at the session open.                                                               |
| Tick N                     | Closes after N trades.                                                                                                                                                                                   |
| Volume N                   | Closes once volume ≥ N; the crossing trade stays in the bar (no splitting).                                                                                                                              |
| Delta N                    | Closes once \|delta\| ≥ N.                                                                                                                                                                               |
| Range N                    | A trade that would make high − low exceed N ticks opens a new bar (the bar may close anywhere inside its range; gaps allowed).                                                                           |
| Range X N                  | Close-beyond rule: the bar closes on the trade that makes high − low = N. A trade past the boundary completes the bar at exactly N ticks (close = boundary) and opens the next bar at its own price.     |
| Range XV N / V             | Closes on the first trade where high − low ≥ N **and** volume ≥ V; until the volume filter is met the range keeps growing.                                                                               |
| Range Z N                  | Plain range rule, but every bar opens at the previous bar's close (open, high, low include it), so there are no gaps.                                                                                    |
| Range US o / t / r         | Universal range: closes when close − open ≥ t ticks in the trend direction or ≥ r ticks against it (t for both before the first bar). The next bar opens at close − dir × o (open offset).               |
| Renko B                    | Bricks of B ticks with the classic 2-box reversal: up brick when price ≥ last top + B, down when ≤ last bottom − B; a gap makes several bricks (the later ones empty). Wicks = traded extremes (option). |
| Reversal S / R             | Closes when high − low ≥ S, or when an up bar (close ≥ open) pulls back R ticks from its high (down bar: R from its low).                                                                                |
| Order Flow N               | New bar after N consecutive prints of the other aggressor side (N = 1: every side change). Prints without a side stay in the current bar.                                                                |
| Cumulative Trades min..max | One bar per aggregated order (consecutive prints with the same timestamp and aggressor side); only orders whose size is within [min, max] are kept (max 0 = no upper limit).                             |
| Heikin-Ashi P              | Time bars of P with HA close = (O+H+L+C)/4, HA open = (prev HA open + prev HA close)/2, high / low include both. Clusters are the raw traded clusters.                                                   |
| Point & Figure B × R       | Columns of B-tick boxes; an X column extends while `floor(px/B)` rises and reverses to O when `ceil(px/B)` ≤ top − R (O column starts one box lower); symmetric for O. One bar per column.               |
| Kagi R                     | Segments reverse after R ticks from the extreme. Yang (thick) once a line rises above the previous shoulder, yin once it falls below the previous waist; `thick0`, `thick`, `flip` describe a segment.   |
| Line Break N / P           | Uses the close of each P period: a new line continues the trend when the close passes the last line, and reverses only past the extreme of the last N lines. The forming line is provisional.            |

**Sessions.** A bar spec may carry `session: 'rth' | 'eth' | '24h' | {open, close, tz?, days?}`. `MarketStore.getSeries` resolves it through `setSessionResolver` (the app wires the market catalog: `sessionRules()` in `@htflow/market-catalog`). Trades outside the session are skipped; crypto (24/7) needs no filter. Lookups are cached per minute.

**Time at price.** `Cluster.tap` (ms): the time from each print to the next print is credited to the earlier print's price, capped at the bar end for time bars and at 5 minutes otherwise.

**Benchmark.** `aggregator.bench.test.ts` feeds 10M synthetic ticks (typed arrays) into M1 cluster bars; about 0.5 s on the dev container.

**Disabled chips.** `specUnavailableReason(spec, capabilities)` greys out bar types that need data the feed lacks (aggressor side for Delta / Order Flow, ticks for non-time bars, sub-second timestamps). Feeds may declare `capabilities`; otherwise they are inferred from the trades.

Cluster cell: `bid` = volume sold into the bid (sell aggressor), `ask` = volume bought at the ask (buy aggressor), `trades`, `maxTrade`, `tap`. Delta = ask − bid.

## Charts

`ChartCore` owns one `<canvas>`, the x scale (slot index → px; slots are bars, depth columns or prints), the y scale (ticks → px), interaction and axes. Everything chart-specific is a `ChartLayer` with optional `priceRange`, `leftGutter`, `rightGutter` and `bottomHeight`. A frame is drawn only when invalidated and at most once per animation frame.

The four core charts are layer stacks over ChartCore (`apps/desktop/ui/src/charts/buildChart.ts`):

- **Candles + VP** — `PeriodProfilesLayer` (1 h, or 1 day on ≥ H1), `CandlesLayer`, `SessionSeparatorLayer`, `VolumePaneLayer`, `LastPriceLayer`, `LegendLayer`.
- **Footprint** — `VisibleProfileGutter` (left), candle strip, `FootprintLayer`, `DomHistogramGutter` (right), `StatsRowsLayer` (bottom).
- **Liquidity Map** — `LiquidityMapLayer` (depth columns → pixel buffer → scaled draw, bubbles, stepped best price, DOM column).
- **Order Flow (Dark)** — two ChartCores: candles + heat rows on the left share the price scale of the tape chart (bubbles per smart print, DOM backdrop) on the right.

Footprint auto-collapses to candles when the slot is narrower than 20 px. Rows merge automatically (1, 2, 4, 5, 10 … ticks per row) so text stays ≥ 13 px tall.

## Local accounts (P03)

```
<root>/profiles/<uuid>/profile.json   username, display name, wrapped keys, attempt counters (no secrets)
<root>/profiles/<uuid>/settings.bin   sealed JSON map (preferences, workspace, …)
<root>/profiles/<uuid>/vault.bin      sealed JSON map (broker / API credentials)
```

`<root>` is `%APPDATA%\HTFlow\`, or `<exe dir>\data\` when a file named `portable` sits next to the executable.

- A random 256-bit **data key** encrypts `settings.bin` and `vault.bin` (XChaCha20-Poly1305, random 192-bit nonce, purpose-bound AAD).
- The data key is stored only wrapped: under Argon2id(password), Argon2id(24-word recovery code) and optionally Argon2id(PIN). Each wrap has its own salt.
- Wrong password → the AEAD tag fails → nothing decrypts. After 3 failures login is delayed 1, 2, 4 … 300 s. 5 wrong PINs remove the PIN.
- "Remember me" stores the data key in Windows Credential Manager (`keyring`). Lock (Ctrl+L) blocks auto-login for the rest of the run.
- `.htprofile` export = the profile metadata (wrapped keys) + the sealed files. It stays encrypted.

Deviation: the spec asks for SQLCipher; see `BLOCKERS.md`.

## IPC and security

- Tauri commands are the only bridge (`apps/desktop/src-tauri/src/*_cmds.rs`); the capability file (main window and `ht-w-*` OS windows) allows only window controls on top of `core:default`.
- Errors cross IPC as `{ code, message }` and never contain secrets; `Debug` for sessions and vaults redacts keys and values.
- CSP: `default-src 'self'`, IPC only; the UI does not load remote content.

## Separate OS windows (P02 / P25 / P44)

A dock group (Detach window), a cloned / linked window ("in new OS window") or a saved workspace (Open workspace in new window) can live in its own Tauri `WebviewWindow`, labelled `ht-w-…`. Each OS window loads the same UI with `index.html?window=<label>` and renders only its windows with a compact title bar (Re-attach, minimise, maximise, close = re-attach).

```
 main window (owner)                                  OS window ht-w-…
 useWindows (every window state) ─ windows ─────────►  useWindows (its windows only)
 settings store (saves)          ◄─ windows/layout ──  dockview layout
 paper engine (fills, saves)     ─ settings ◄──────►  settings (no save)
 OS-window registry → tab.osWindows ─ paper.state ──► mirrored accounts (no fills)
                                 ◄─ paper.call ─────  trading actions
            one global Tauri event `htflow:bus` (ui/src/platform/windowBus.ts)
```

- **Ownership: the main window owns the state, each window subscribes to market data itself.** Every OS window has its own JS context and its own `MarketHub`; the Rust connectors serve several subscribers, so forwarding every trade over IPC would only add latency. What is shared is small and changes rarely: window states (instrument, template, link group …), settings (theme included), paper accounts and per-profile stores. This was the simpler, robust option: one writer per file, no merge logic.
- **Messages** are typed (`BusMsg`) and validated on receipt (`parseBusMsg`). A new OS window sends `hello`; the main window answers `init` (session, its window states, settings, paper snapshot). Changes travel as diffs (`diffWindows`, `diffValues`), so an echo of an equal state is never resent. The main window applies window changes through `useWindows.patch`, so link groups work across windows.
- **Trading** runs only in the main window's paper engine. In an OS window the engine is a mirror: fills are off and order actions (`place`, `cancel`, `flatten` …) are sent as `paper.call`; snapshots (`paper.state`) come back after every change.
- **Persistence**: `settings`, `workspace`, `workspaces.library` and `trading.accounts` are written by the main window only. Other `Persisted` stores save where they change and announce `store.saved`; the other windows reload them.
- **Layout**: open OS windows are saved with the layout tab (`WorkspaceTab.osWindows`: label, title, window ids, inner layout) and reopen at start-up, on tab switch and on workspace load; they close with the main window and on lock. Closing an OS window (or Re-attach) puts its windows back into the main dock.
- **Native side** (`src-tauri/src/os_windows.rs`): `os_window_open / close / focus / list`, label validation, bounds and monitor per label in `<data>/windows.json` (64 most recent labels), clamped to the connected monitors when the window opens again (`clamp_bounds`). The capability file covers `main` and `ht-w-*`.
- **Browser build**: no second native window; every entry point falls back to an in-app floating window, and the `?window=` route shows a "waiting for the main window" page.

## Browser development mode

`pnpm dev:web` runs the UI in a normal browser. `ui/src/backend/web.ts` replaces the Rust core with a WebCrypto + localStorage implementation so the UI and Playwright tests run without Tauri. It is never used by the Windows app.
