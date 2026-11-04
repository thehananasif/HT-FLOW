# HT Flow

Professional order-flow trading platform for **Windows 10/11 (x64)** — footprint, liquidity map, DOM, tape and paper trading, with an original monochrome design. Built with Tauri 2 (Rust core + WebView2) and React + TypeScript. **$0 cost:** no paid libraries, no paid APIs, no cloud backend — your account and data stay on your PC.

> Status: **0.1.0 fast-track foundation.** See [`docs/FEATURES.md`](docs/FEATURES.md) for what is done and what is next, and [`docs/BLOCKERS.md`](docs/BLOCKERS.md) for deviations.

## What works today

- Local encrypted accounts (Argon2id + XChaCha20-Poly1305), recovery code, PIN, Windows Credential Manager "Remember me", `.htprofile` export/import
- Dashboard with docking windows, 5 layout presets, layout tabs, link groups, ribbon, Command Palette (Ctrl+K)
- Four core charts on one renderer: Candlesticks + Volume Profile, Footprint (21 modes, imbalances, statistics rows), Liquidity Map, Order Flow (Dark)
- DOM ladder with one-click paper trading, Trading Panel, paper engine with multi-target brackets
- Data: built-in seeded simulator for crypto and futures, and live **Binance USDⓈ-M Futures** (free, no key)

## Get the Windows app

Every push builds the installer on GitHub Actions (`windows-latest`). Open **Actions → CI → Build Windows x64** and download the `HTFlow-windows-x64` artifact (`HT Flow_0.1.0_x64-setup.exe`). See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Build from source (Windows)

Prerequisites: [Node.js 22](https://nodejs.org), pnpm 10 (`corepack enable`), [Rust stable](https://rustup.rs) with the MSVC toolchain, and Microsoft C++ Build Tools. WebView2 is preinstalled on Windows 10/11.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` opens the HT Flow window with hot reload. Build the installer:

```bash
pnpm build
```

The installer lands in `target/release/bundle/nsis/`.

UI only, in a browser (uses an in-browser stand-in for the Rust core):

```bash
pnpm dev:web
```

## Checks

```bash
pnpm check
```

Runs typecheck, ESLint, Vitest, rustfmt, clippy and `cargo test`. End-to-end UI tests:

```bash
pnpm e2e
```

## Docs

- [`docs/FEATURES.md`](docs/FEATURES.md) — every feature from the 46-phase spec with status
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — repo layout, live pipeline, bar rules, security model
- [`docs/BLOCKERS.md`](docs/BLOCKERS.md) — blocked items and deviations
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — install and use
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)

## Licence

MIT for HT Flow code. Geist and Geist Mono fonts: SIL Open Font License 1.1 (`packages/ui-kit/src/fonts/OFL-Geist.txt`).
