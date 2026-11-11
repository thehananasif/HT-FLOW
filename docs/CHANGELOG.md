# Changelog

## Unreleased — round 2c

### Changed

- Paper trading now charges the default commission (0.02% / 0.05% crypto, $4.50 round turn futures); it was 0.
- Letter and digit hotkeys read the physical key (Shift+1 is "Shift+1"); single-key shortcuts don't fire in a focused select box.

### Added

- Data layer (P05 / P06 / P32): `crates/tick-store` recorder and reader, history merge with gap backfill, Bybit linear connector, tick-store replay source, new Connections window with add-connection wizard, Data manager.
- Market catalog (P04): `@htflow/market-catalog` with Appendix A seed, sessions, expiry / roll rules; new Instrument Picker; Watchlist; Forward Curve (P19, simulated prices).
- Options (P18): `@htflow/options` pricing, Greeks, IV, strategies, simulated chains and Deribit provider; Options Strategy Analyser window.
- Info group (P22 / P39): `@htflow/info`; RSS Reader, News, Economic Calendar (with chart lines), TradersTalk; Rust `net_fetch_text` command.
- Settings centre (P27 / P43): typed settings store, Settings window with General, Appearance, Hot keys, Sounds, Time zones, Commission, Data delays, Performance and Common settings; hotkey overrides with scopes.
- Tape and analytics (P16 / P21 / P38): `@htflow/tape` and `@htflow/analytics`; Smart Tape, Bid/Ask Tape, All Prices, Market Pressure, Price Change, DOM Pressure, Delta Divergence windows.
- Indicators (P13 / P14): `@htflow/indicator-sdk` and `@htflow/indicators` (63 indicators, 281-entry catalog), chart extension with canvas legend and sub-panes, Indicators dialog with presets; `docs/INDICATORS.md`.

## Unreleased — round 2b

### Added

- Replay (P24 / P35): `@htflow/replay` engine and sources, `replay:` feed provider, Replay window with templates and a separate replay paper account, chart replay control bar and hotkeys.
- Risk management (P23 / P41): rule engine on paper-engine pre-trade / post-fill hooks, presets, override password, persistent locks, Risk window, title-bar meter.
- Alerts (`@htflow/alerts`) with runtime, Alerts window and chart alert lines.
- Trading Journal (P36), Trading Activity log, DataTable with sort / filters / grouping / saved views / CSV; Accounts / Positions / Orders / Trades rebuilt on it (P20 / P40).

### Changed

- A round trip that nets exactly zero now counts as break-even, not a loss.

## Unreleased — round 2

### Added

- Extension points for parallel work: module registry (`modules/<name>/index.tsx`), feed-provider registry, chart extensions (layers, pointer handlers, overlays, menu items) and chart-header items; `docs/AGENT_GUIDE.md`.
- ChartCore: pointer / keyboard handlers for extensions; each layer with a bottom pane gets its own stacked rect.
- `MarketHub` ensure / retain / release with a 3 s grace period; per-store trade listeners.
- Drawing tools (P12): `@htflow/drawings` with 67 tools, anchors, magnet, lock / hide / clone, style toolbar, per-timeframe visibility, linked-chart sync, Objects List, Undo / Redo, hotkeys; side-tool drawing groups are live.

## 0.1.0 — 2026-11-04 (fast-track foundation)

### Added

- Monorepo: pnpm workspaces + Cargo workspace, Tauri 2 desktop app for Windows, Vite + React 18 + TypeScript (strict), ESLint, Prettier, rustfmt, clippy, Vitest, Playwright, GitHub Actions on `windows-latest` (checks, tests, e2e, NSIS installer artifact).
- `@htflow/ui-kit`: HT design tokens with 5 themes, bundled Geist / Geist Mono, buttons, ribbon buttons, segmented controls, chips, tabs, inputs with steppers, selects, checkboxes, toggles, sliders, menus, dialogs, toasts, badges, status pills; dev UI Gallery.
- Local accounts (Rust `htflow-auth` + `htflow-vault`): Argon2id-wrapped data keys, XChaCha20-Poly1305 encrypted settings and credential vault, 24-word recovery code, 6-digit PIN with lockout, failed-login backoff, Windows Credential Manager "Remember me", encrypted `.htprofile` export / import; login / create-account screen.
- Dashboard: dockview docking, 5 layout presets, workspace tabs, link groups, title bar, ribbon, status bar, Command Palette (Ctrl+K), Trading Panel.
- Market data: seeded order-flow simulator (MockFeed), L2 order book, incremental bar aggregator (time / tick / volume / delta / range) with per-price clusters, volume profile with value area, per-instrument store shared by windows.
- Charts on one ChartCore: Candlesticks + period Volume Profile, Footprint (21 modes, imbalances, stacked zones, statistics rows, visible-range profile, DOM histogram), Liquidity Map, Order Flow (Dark); side tools; chart right-click menu.
- DOM ladder with one-click paper trading and DOM Trader; paper engine with brackets (multi-target), OCO, reduce-only, IOC/FOK, reverse, breakeven, flatten; Accounts / Positions / Orders / Trades tables.
- Binance USDⓈ-M Futures connector (Rust): aggTrade + depth@100ms, snapshot sync with sequence-gap detection, reconnect with backoff, REST history backfill; streamed to the UI in 16 ms batches.
