# HT Flow — Feature checklist

Every feature from every phase of the master build spec. Agents: read this first and continue from what is unfinished.

Legend: `[x]` done and tested · `[~]` partly done (note says what is missing) · `[ ]` not started · `[!]` blocked (see `BLOCKERS.md`)

Build order followed so far: **Section 8 fast-track** — P01 → P02 → P03 → P44 → MockFeed → ChartCore → P46 → P45 → DOM + Trading Panel + paper engine (P17) → Binance Futures connector (P05) + live bus.

---

## P01 — Project scaffold

- [x] pnpm workspaces + Cargo workspace (repo layout per Master Context)
- [x] Tauri 2 app in `apps/desktop` (Rust core + WebView2 UI), Vite + React 18 + TypeScript strict
- [x] Geist + Geist Mono bundled locally (SIL OFL)
- [x] ESLint, Prettier, rustfmt, clippy, Vitest, Playwright
- [~] cargo-nextest — not added; `cargo test` is used in CI
- [x] GitHub Actions (free): Windows x64 build artifact (.exe + NSIS installer) and tests on every push
- [~] Typed IPC layer — commands + typed TS wrappers written by hand; tauri-specta code generation not yet added
- [~] Binary (ArrayBuffer) event bus for high-rate streams — live data uses one coalesced batch per 16 ms over a Tauri channel (compact arrays); switching the payload to raw ArrayBuffer is pending
- [x] `docs/FEATURES.md` lists every feature from all phases

## P02 — Design system + application shell

- [x] Tokens: dark default + Dark Blue, Gray, Light, High-Contrast themes; all tokens exported as plain objects (JSON-ready)
- [x] tnum on for numbers, focus rings, 8 px grid, radii and control sizes per spec
- [x] Button (primary / secondary / outline / buy / sell / destructive / ghost / icon), IconButton, RibbonButton (icon over label + chevron)
- [x] SegmentedControl, Chip, Tabs, Input, NumberInput with ▲▼ stepper and step/tick snapping (PriceInput), Select, Checkbox, Radio, Toggle, Slider
- [~] ColorPicker — swatch + hex only; RGBA/opacity, saved swatches and gradient editor pending
- [ ] Combobox (searchable), FontPicker, LineStylePicker
- [x] Tooltip, ContextMenu (nested submenus, icons, shortcuts, checkmarks), DropdownMenu, Dialog, Toast, Badge, Kbd, EmptyState, Skeleton, StatusPill
- [ ] Sliders inside menus, Sheet, virtualized Table component, TreeView, SplitPane (dockview covers docking splits)
- [x] Custom title bar (draggable, logo, workspace name, account menu, min / max / close)
- [x] Ribbon with all groups from APP LAYOUT, horizontal scroll, collapse to icons (command "Ribbon: icons only")
- [ ] Ribbon reorder / hide buttons
- [x] Docking workspace (dockview): tabs, horizontal / vertical splits, drag tabs to re-dock, floating windows, maximize panel
- [!] Detach to a separate OS window / multi-monitor — floating in-app window today (see BLOCKERS)
- [x] Right Trading Panel slot, status bar, Command Palette (Ctrl+K) searching commands, symbols, layouts and modules
- [~] Command Palette searching indicators and settings — those modules do not exist yet
- [x] Dev-only "UI Gallery" page (`?gallery`) showing every component in its states

## P03 — Local accounts: Create account / Login

- [x] First-run screen: full window, black background, centred 420 px card, wordmark, Login / Create account tabs (board 01)
- [x] Create account: display name, username, email (optional, local only, stored encrypted), password + confirm with strength meter (min 10), timezone, default theme, "Remember me", optional 6-digit PIN
- [~] Encrypted profile storage — per-user files sealed with XChaCha20-Poly1305 under a random data key wrapped by Argon2id(m=64 MB, t=3, p=1); **SQLCipher not used** (see BLOCKERS)
- [x] Credential vault encrypted with a key derived from the password; never written in plain text; never logged
- [x] Login: username + password, failed-attempt exponential delay, wrong password never decrypts
- [x] "Remember me" stores the data key in Windows Credential Manager (keyring crate)
- [x] "Forgot password" → 24-word recovery code shown at sign-up (copy / print), resets the password
- [x] Account menu: change password, change PIN, export profile (encrypted .htprofile), switch user, lock (Ctrl+L), logout
- [x] Import profile (.htprofile) from the login screen
- [x] Auto-lock after N minutes idle (30 min default)
- [ ] Profile screen and auto-lock minutes as a user setting (needs Settings centre, P27)
- [x] Tests: two users see only their own settings; wrong password never decrypts; export / import round-trips; KDF and vault unit tests

## P04 — Market catalog & instrument model

- [~] Instrument model (id, symbol, exchange, asset class, tick size, tick value, precision) — used by MockFeed and Binance; sessions, holidays, roll rules, contract specs and provider mappings pending
- [ ] Seed the full Appendix A catalog (US/EU futures, crypto venues from exchange-info, US stocks, indexes, HKEX, single-stock futures, dxFeed groups) with `spec_source_url`
- [~] Instrument Picker — dropdown grouped by source (simulated / Binance Futures); tree, fuzzy search, favourites, recent, "Has live feed" filter, drag to window pending
- [ ] Watchlist panel (named lists, columns, flashes, sort, drag reorder, right-click open)
- [ ] 10,000+ symbol search < 50 ms

## P05 — Data connectors

- [x] Normalised events in Rust: Trade, BookDelta, BookSnapshot, FeedStatus; prices as integer ticks (exact decimal parsing)
- [x] Aggressor detection: venue flag, else tick rule vs best bid / ask
- [~] Connector traits (MarketDataProvider / HistoryProvider / ExecutionProvider) — the UI-side `FeedSource` interface exists; Rust trait objects pending
- [x] Binance USDⓈ-M Futures: aggTrade + depth@100ms, REST snapshot + sequence sync (U / u / pu), gap detection → resync, reconnect with backoff 0.5 s → 30 s + jitter, ping/pong, no-data watchdog
- [ ] Binance spot, COIN-M; Bybit; OKX; Bitget; Kraken; Bitfinex; Phemex; WhiteBIT; Deribit (options); OI / funding / liquidations streams; rate limits; clock-skew correction (NTP)
- [!] Rithmic, CQG, dxFeed, Interactive Brokers, Tradovate, Alpaca — need user credentials / SDKs (see BLOCKERS)
- [ ] CSV / Parquet importer, "Custom WebSocket" JSON-mapping connector
- [~] Connections window — status, latency, msgs/s and provider list with FREE / YOUR ACCOUNT tags; Connect / Disconnect / Edit, add-connection wizard, test button, auto-connect pending (P32)
- [ ] Acceptance: BTCUSDT 1-hour soak with zero sequence gaps (needs a Windows run with network access to Binance)

## P06 — History download & tick store

- [~] Backfill on open: recent aggTrades via REST pagination + depth snapshot (Binance); MockFeed generates N hours of seeded history
- [ ] Columnar per-day tick files (zstd, mmap, index), depth snapshots + deltas recorder, retention / max-disk settings
- [ ] Binance public archives (data.binance.vision) import
- [ ] "Set dates" dialog, "Reload all historical data", Data manager screen
- [ ] Acceptance: 30 days of BTCUSDT into a 1m footprint in < 5 s

## P07 — Aggregation engine

- [x] Incremental + bulk bar builder (same code path), per-price clusters: bid vol, ask vol, total, delta, trades, max single trade
- [x] Time (seconds / minutes / hours / daily / weekly), Tick, Volume, Delta, Range bar types with the preset matrix
- [x] Property test: bulk vs incremental identical for every preset bar type (seeded data)
- [ ] Range X / XV / Z / US variants, Renko, Reversal, Order Flow, Cumulative Trades; Heikin-Ashi, Point & Figure, Kagi, Line Break
- [~] Timeframe dialog — header quick chips (M1 / M5 / H1) + full preset menu by row; "Configure" (custom presets) and disabled-chip logic pending
- [ ] Sessions RTH / ETH / custom per instrument (session selector is in the UI but not applied); time-at-price per cluster
- [ ] Acceptance: 10M ticks → M1 cluster bars < 1 s (not benchmarked yet)

## P08 — Chart engine core

- [~] ChartCore renderer: Canvas2D with dirty-flag redraw at most once per animation frame (**WebGL2 instanced renderer pending**)
- [x] Shared time axis, right price axis, auto-scale + manual drag on price axis, double-click axis reset, wheel = zoom time, Ctrl + wheel = zoom price, Shift + wheel = scroll, drag = pan, Shift + drag = vertical move
- [x] Crosshair with price / time tags, last-price line + coloured tag, bid / ask lines, session breaks with labels, dashed grid, OHLCV legend, debug overlay (render ms)
- [x] Mouse modes: Pointer, Crosshair, Zoom (drag box), Scroll, ZoomXY
- [ ] Global / Sync crosshair, multiple resizable panes, log / percent / indexed / inverted scales, gaps on/off, time-zone selection, countdown timer, high / low marks, watermark, data window panel, alerts lines
- [x] Display modes: Footprint modes (Alt+V / T / B / D), Bars, Candles, Transparent candles, Line, Area, Hidden (right-click → Mode)
- [x] Level-of-detail: footprint collapses to candles below 20 px slot width (configurable)
- [x] Window header: link-group dot, instrument, timeframe chips + menu, lots, template menu, Indicators (disabled), Live / Sim badge, snapshot camera (copy PNG), maximize, settings, close; bottom bar: go-to-latest, session selector, history info, DOM Trader, Trading Panel
- [ ] Compare / overlay instrument, calendar "go to date", pin, alerts button
- [ ] Acceptance: 8 charts at 60 fps with 1M ticks; Playwright test for every mouse mode / shortcut

## P09 — Chart templates

- [x] Built-in templates: Japanese Candlesticks with Volume Profile, Footprint chart, Liquidity Map, Order Flow (Dark) — switching re-renders from the same data
- [ ] Order Flow (Light), Imbalance Chart, TPO Chart, On-Chart Liquidity Map, Multi-timeframe Chart, Volume Histogram, COT Chart (listed disabled in the template menu)
- [ ] User templates as JSON: save as / rename / duplicate / delete / export / import / default per instrument class / favourites; style presets (White, Light, Dark, Black, …)

## P10 — Footprint / cluster engine

- [x] Content modes: Volume, Trades, Bid x Ask, Delta, Volume x Trade, Volume x Delta
- [x] Styles: numbers, histogram, digital histogram, delta-coloured, ladder, bid/ask volume profile, delta profile; heat by volume / delta
- [x] POC box per bar, candle strip inside each cluster
- [x] Diagonal imbalance (default 300 %, min volume), stacked imbalance zones (N levels) extended right
- [x] Price merging: ticks-per-row auto / 1 / 2 / 4 / 5 / 10, font auto-fit
- [x] Cluster statistics rows (Delta, Session Delta, Volume, plus Trades / Delta % / Max / Min delta available) — colour-graded
- [~] Footprint quick-settings dialog (mode, ticks per row, imbalance ratio, stacked levels, auto-collapse width, POC) — colours, filters, presets, value area per bar, horizontal imbalance pending
- [x] Tests: hand-computed rows, imbalances and stacked zones
- [ ] Acceptance: 2,000 visible clusters at 60 fps (not benchmarked)

## P11 — Heatmap / Liquidity map

- [x] Depth-history heat texture (one pixel per column × price row, scaled without smoothing), column size 250 ms / 1 s / 5 s
- [x] Gradient presets + LUT, brightness, upper / lower cut-off percentiles (98 / 20), linear / log / sqrt scale
- [x] Trade bubbles (aggregated per column and side, Lots ≥ filter 1 / 2 / 5 / 10 / 100), stepped best-price line (green up / red down), right DOM column with sizes, prices and highlighted current price
- [ ] Standalone Heatmap window as a separate module, quick-settings popover sections with help icons, custom gradient editor, normalise per column, bubble pie / dominant styles and tooltip, volume bars, 3D mode (three.js), full settings dialog (large-order outline, order lifetime colours, icebergs, spoof flashes), left drawing toolbar
- [ ] Acceptance: CL-like replay at 30 fps; 3D toggle

## P12 — Drawing tools

- [~] Side-tool groups list every tool with its shortcut (Lines, Shapes, Volume Analysis, Fibonacci, Measurement, Elliott, Markers, Text, Positions, Gann & Pitchfork, Objects) — **tools are disabled until P12**
- [ ] Every drawing tool, anchors, magnet, lock / hide / clone, styles, extend, per-timeframe visibility, sync across charts, alerts on cross, Objects List, Undo / Redo

## P13 — Indicator framework

- [ ] Indicator SDK (metadata, typed inputs, outputs, incremental calc, worker pool, Rust WASM path)
- [ ] Indicators dialog (categories, added list, settings tabs: Inputs / Style / Alerts / Visibility / Advanced, presets, apply to all)
- [ ] On-chart legend, drag to pane, overlay other symbol, Monaco editor for custom TS indicators (.htind)

## P14 — Indicator catalog (280+)

- [ ] Batch A Volume & OrderFlow (36) · Batch B Order Book / Options / COT / Crypto / Trading / Samples · Batch C moving averages & bands · Batch D oscillators, trend, volatility, levels, structure (see Appendix B)

## P15 — Smart DOM

- [x] DOM ladder (board 24): Orders / PnL, Today (session volume), Price, Chg., Bid, Sells, Buys, Ask, Chg. — canvas renderer
- [x] Auto-centre with manual scroll (wheel) and re-centre (double-click / C), price grouping 1 / 2 / 5 / 10, depth bars, current price row, spread line
- [x] One-click trading: left-click = buy limit, right-click = sell limit, Ctrl = stop; click Orders column = cancel at price; footer: reverse, cancel all / bids / asks, MKT buy / sell, Flatten all, Trading Panel, lock trading
- [x] DOM Trader: compact DOM docked right of any chart (bottom-bar toggle)
- [ ] Column toggle / reorder / resize / colours, Volume-at-price visible range, last trade size, delta at price, cumulative depth, notes, limit tracking, iceberg markers, VA / POC marks, P&L at price, pulled / stacked flashes, drag orders to modify, lot presets
- [ ] 13 templates (Basic Extended … Prop DOM) + template designer
- [ ] Acceptance: 20 updates / ms burst without frame drops

## P16 — Smart Tape, Bid/Ask Tape, All Prices

- [ ] Smart Tape · Bid/Ask Tape · All Prices (ribbon entries open placeholders)

## P17 — Trading Panel, orders & paper engine

- [x] Trading Panel (board 02): account selector with masked id + eye toggle, qty with lot presets, BUY / SELL MARKET, BUY / SELL ASK, BUY / SELL BID, Cancel Bids / Asks / All, Reverse, Breakeven (H), Close, PnL, position / entry, OCO, TIF (GTC / DAY / IOC / FOK / GTD), Reduce-Only, SL / TP toggle with TP / SL ticks; toggle with T
- [x] Paper engine: market orders walk the live book (partial levels), limits rest and fill when the tape trades through, stops trigger on last trade, IOC / FOK, reduce-only, lock trading, commissions, realized / unrealized PnL
- [x] Brackets with multiple targets: SL + N take-profits (OCO), stop shrinks as targets fill, stop fill cancels targets
- [x] Trading from chart: right-click Buy / Sell Limit or Stop at cursor price
- [ ] Iceberg, MIT, trailing stop, stop-limit UI, ATM templates (auto-breakeven, trailing steps), trailing / ATR SL types, TP units $/% / points, drag orders on chart, position line on chart, confirmations, multiple paper accounts, reset account UI
- [x] Tests: bracket with 3 targets fills correctly; PnL matches hand calculation

## P18 — Options Board & analytics

- [ ] Options Strategy Analyser window, Greeks (Black-76 / Black-Scholes), IV solver, strategy builder, payoff chart, Deribit data

## P19 — Forward curve

- [ ] Forward Curve window (expiries, contango / backwardation, spreads, roll calendar, basis)

## P20 — Tables group

- [~] Accounts, Positions (Close / Reverse / Flatten all), Orders (cancel / cancel all), Trades (fills) tables from the paper engine — virtualisation, column chooser, filters, grouping, CSV / XLSX export, saved views pending
- [ ] Trading Activity, Trading Journal (stats engine exists in `@htflow/trading`: FIFO round trips, win rate, profit factor, expectancy, max DD), Trading Strategies

## P21 — Market analytics tools

- [ ] Market Pressure, Price Change, DOM Pressure, Delta Divergence scanners

## P22 — Info group

- [ ] RSS Reader, News, Economic Calendar, TradersTalk

## P23 — Alerts & Risk Management

- [~] Daily-risk meter in the title bar (paper account loss vs limit)
- [ ] Alerts engine and manager; risk rules, prop-firm presets, auto-flatten and lock

## P24 — Replay

- [ ] Tick + depth replay through the same bus, speed 0.25×–1000×, step, replay account

## P25 — Workspaces, layouts, linking

- [x] Workspace saved per user (encrypted settings): every window's state + dockview layout; autosave on change and every 60 s; restore on start
- [x] Layout tabs at the bottom (each tab = saved layout), add / rename (double-click) / close
- [x] Link groups (none / red / green / blue / yellow / purple): changing the instrument in one window changes the whole group
- [ ] Save / load / duplicate / export / import workspaces, starter workspaces, layout settings, "Create linked window", "Clone window", multi-monitor restore

## P26 — Chart right-click menu

- [~] Buy Limit / Sell Stop (or Sell Limit / Buy Stop) at cursor price, Trading Panel, DOM Trader, Mode ▸ (Footprint modes, Bars, Candles, Transparent, Line, Area, Hidden), Mouse ▸, Reset, Export PNG — Go to date, Change instrument, Templates ▸, Indicators, Overlay, Drawing objects ▸, Chart strategies, Layouts ▸, Create linked window, Clone, Hide panels, Trading session ▸, Refresh, Reload history, Add replay template, Export CSV / JSON, Full screen, Settings pending; context-aware menus pending

## P27 — Settings & customization centre

- [ ] Global Settings (Ctrl+,) and Chart Settings (Ctrl+S) with every section; token editor; JSON export / import

## P28 — Remaining modules

- [ ] Following Manager, Web Pages, Logs, chart strategies + backtests, snapshots to journal, in-app User Guide, guided tour, sample replay data

## P29 — QA, performance & hardening

- [ ] Full audit, benchmarks vs targets, 8-hour soak, crash reporter, accessibility pass, security review
- [x] CSP set for the WebView; IPC allow-list via Tauri capabilities; secrets never logged (Debug impls redact)

## P30 — Windows installer & release

- [x] NSIS per-user installer (no admin) built in CI; app icon (original artwork)
- [ ] MSI, portable zip (portable mode is supported at runtime via a `portable` marker file), shortcuts, file associations (.htprofile, .htworkspace, .htind, .htidea), uninstall keep/remove data, auto-update via GitHub Releases + signed manifest, release notes, code-signing notes

## Section 6 — Live pipeline

- [x] Stage 1 Connect (Binance Futures) · [x] Stage 2 Normalise (ticks) · [x] Stage 3 Book builder with sequence check
- [~] Stage 4 Event bus — bounded channel per subscription; slow consumer never blocks the socket (drops to snapshot mode); lock-free ring buffer pending
- [ ] Stage 5 Recorder (tick store)
- [~] Stage 6 History merge — history then live on one chart; gap detection, dedupe at the seam and lazy left-scroll loading pending
- [x] Stage 7 Aggregator (shared series per instrument + bar type) — in TypeScript on the UI side today
- [ ] Stage 8 Indicator engine (worker pool)
- [~] Stage 9 UI streamer — 16 ms coalescing per subscription; hidden-window suppression and binary payloads pending
- [~] Stage 10 Render — Canvas2D, redraw only when dirty (WebGL2 + SDF text pending)
- [~] Stage 11 Actions — paper engine fills from the live book + tape; alerts / risk pending
- [~] Stage 12 Observability — msgs/s, latency (EWMA), connection state per feed in the status bar and Connections window; p50 / p99, gaps counter in UI pending

## P31–P43 — Detailed window specs

- [~] P31 Trading workspace v2 — template switch keeps zoom; legend lines; session separators; stats rows; DOM Trader; status pills per connection. Pending: Snapshots in template menu, "Load days", "◂ Load 1 more day", previous-session profile on the left
- [~] P32 Connections window — see P05
- [~] P33 Chart types — 4 of 12 renderers (+ bars / line / area / transparent)
- [ ] P34 Chart settings window
- [ ] P35 Chart Replay control · [ ] P36 Trading Journal window · [ ] P37 Workspaces / templates / layout settings windows · [ ] P38 Market analytics windows · [ ] P39 RSS / News / Calendar · [~] P40 tables (see P20) · [ ] P41 Watchlist / Alerts / Risk / Forward curve · [ ] P42 Strategies + VPS runner · [ ] P43 Common settings (hot keys, sounds, time zones, commission, languages, custom modules)

## Section 8 — Fast-track (Dashboard v3 + 4 core charts)

- [x] P44 Dashboard: dockview tabs / splits / floating, 5 layout presets (DOM | Chart | Panel, Grid 2×2, 1 + 2, Split, Single), "Main chart" chips, Split right / down, Detach (floating), daily-risk meter, account avatar, workspace tabs, status bar pills; layout JSON persisted per user
- [!] P44 pop-out to a separate OS window (see BLOCKERS)
- [x] P45 Side tools: 34 px bar, footprint quick settings, vertical footprint mode tabs with flyouts (Volume ›, Trades ›, Bid x Ask ›, Delta ›), drawing groups with shortcuts, compact mode (< 520 px), Esc / outside-click closes
- [x] P46 four core charts on one ChartCore: Candles + period Volume Profiles (vPOC, VAH / VAL), Footprint (visible-range profile, candle strip, clusters, DOM histogram, statistics rows), Liquidity Map, Order Flow (Dark: candles + heat rows | tape chart with bubbles, DOM backdrop, best bid / ask, big-level line, Lots ≥ filter)
- [x] MockFeed (seeded ticks + depth) → same `FeedSource` interface as live
- [x] Binance Futures connector + history merge → live bus (desktop app)
- [ ] Acceptance: 4 charts on BTCUSDT with 4 days of history + live at 60 fps (needs tick store + Windows benchmark)

## Appendix C — Default shortcuts

- [x] Ctrl+K command palette · T Trading Panel · Ctrl+L lock · H breakeven · Alt+V / T / B / D footprint modes
- [ ] Ctrl+G, Ctrl+R (menu item only), Ctrl+S, Ctrl + double-click, Shift+B / C / T / L / M / H (menu only), F-keys drawings, M magnifier, Del / Ctrl+Z / Ctrl+Y, rebinding in Settings → Hotkeys
