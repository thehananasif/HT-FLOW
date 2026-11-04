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

All bar types use the same incremental `BarSeries.add(trade)` for history and live, so bulk and incremental builds are identical (property-tested for every preset).

| Type     | Rule                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| Time     | Bar open = `floor(ts / period) * period` (UTC aligned). Empty periods produce no bar. |
| Tick N   | Closes after N trades.                                                                |
| Volume N | Closes once volume ≥ N; the crossing trade stays in the bar (no splitting).           |
| Delta N  | Closes once \|delta\| ≥ N.                                                            |
| Range N  | A trade that would make high − low exceed N ticks opens a new bar.                    |

Range X / XV / Z / US, Renko, Reversal, Order Flow and Cumulative Trades bars are not implemented yet; their rules will be documented here when they are.

Cluster cell: `bid` = volume sold into the bid (sell aggressor), `ask` = volume bought at the ask (buy aggressor), `trades`, `maxTrade`. Delta = ask − bid.

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

- Tauri commands are the only bridge (`apps/desktop/src-tauri/src/*_cmds.rs`); the main window's capability file allows only window controls on top of `core:default`.
- Errors cross IPC as `{ code, message }` and never contain secrets; `Debug` for sessions and vaults redacts keys and values.
- CSP: `default-src 'self'`, IPC only; the UI does not load remote content.

## Browser development mode

`pnpm dev:web` runs the UI in a normal browser. `ui/src/backend/web.ts` replaces the Rust core with a WebCrypto + localStorage implementation so the UI and Playwright tests run without Tauri. It is never used by the Windows app.
