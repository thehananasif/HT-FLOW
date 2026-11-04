# Changelog

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
