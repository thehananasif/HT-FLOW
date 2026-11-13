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
- [x] ColorPicker v2 (saturation / hue / opacity, hex / rgb, saved swatches, recent colours), GradientEditor (multi-stop, LUT for heatmaps); `ColorSwatch` kept for compatibility
- [x] Combobox (searchable, async, free text), FontPicker (bundled + common system fonts), LineStylePicker (`dashPattern()` for canvas)
- [x] Tooltip, ContextMenu (nested submenus, icons, shortcuts, checkmarks), DropdownMenu, Dialog, Toast, Badge, Kbd, EmptyState, Skeleton, StatusPill
- [x] MenuSlider (and slider menu entries), Sheet, virtualized Table (sort, fixed header, single / multi selection, keyboard), TreeView (tri-state checkboxes), SplitPane (keyboard, min sizes, ratio callback); all in the UI Gallery
- [ ] Popovers are plain positioned panels (no Radix Popover; can clip in `overflow: hidden`); Table has fixed row heights, no column resize / reorder; local fonts not enumerated
- [x] Custom title bar (draggable, logo, workspace name, account menu, min / max / close)
- [x] Ribbon with all groups from APP LAYOUT, horizontal scroll, collapse to icons (command "Ribbon: icons only")
- [x] Ribbon: right-click Hide button / Customize ribbon… (show / hide, drag or keyboard reorder, reset), saved per user
- [x] Docking workspace (dockview): tabs, horizontal / vertical splits, drag tabs to re-dock, floating windows, maximize panel
- [!] Detach to a separate OS window / multi-monitor — floating in-app window today (see BLOCKERS)
- [x] Right Trading Panel slot, status bar, Command Palette (Ctrl+K) searching commands, symbols, layouts and modules
- [x] Command Palette searching indicators and settings — indicators (catalog entries with an implementation) add to the active chart; settings sections and keys open the Settings window at their section; results grouped under "Indicators" and "Settings" after the commands
- [x] Command Palette focuses its search box synchronously when it opens, so keystrokes no longer reach the chart underneath
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

- [x] `@htflow/market-catalog`: instrument model with Appendix A groups, sessions with exchange time zones and DST (RTH / ETH, breaks), expiry and roll rules (month cycles, last-trading-day rules, contract codes, auto-rolled front month), `spec_source_url` and `verified` flag; feed matching (Sim / Binance / replay)
- [~] Full Appendix A seed (US / EU futures incl. micro / mini / E-nano, 16 crypto venue groups, VX, HKEX, single-stock futures, dxFeed groups); uncertain specs are `verified: false` with `TODO(verify)`; stocks and crypto symbol lists are placeholders; no holiday dates; specs not yet checked against exchange pages
- [x] Instrument Picker: group tree, All / Favourites / Recent, typo-tolerant search (12k entries < 50 ms), star, "Has live feed" filter, status column (Live / Sim / Delayed / Replay / No feed), keyboard navigation; no-feed rows offer Connections
- [x] Watchlist: tabs and user lists, Last flash, Chg %, Volume, Delta, sparkline, column chooser, drag reorder, sort, right-click open Chart / DOM / Heatmap / Tape, link-group colour, feeds retained only for visible rows
- [x] Drag from picker to a window (changes its symbol) / Ctrl+drag or empty dock area for a new chart window
- [x] Watchlist OI / Funding column fed by the crypto connectors' funding / open-interest streams ("—" when absent)
- [x] Search index: whole-entry character-mask reject; vitest benchmark asserts < 50 ms on 10k generated instruments
- [~] Roll by volume implemented in the catalog (`volume` roll spec + per-contract volumes, date fallback)
- [ ] No provider supplies per-contract volumes yet and no seed contract uses a `volume` roll spec; drag has no keyboard / palette equivalent (the `inst.*` commands cover changing the symbol)

## P05 — Data connectors

- [x] Normalised events in Rust: Trade, BookDelta, BookSnapshot, FeedStatus; prices as integer ticks (exact decimal parsing)
- [x] Aggressor detection: venue flag, else tick rule vs best bid / ask
- [~] Connector traits (MarketDataProvider / HistoryProvider / ExecutionProvider) — the UI-side `FeedSource` interface exists; Rust trait objects pending
- [x] Binance USDⓈ-M Futures: aggTrade + depth@100ms, REST snapshot + sequence sync (U / u / pu), gap detection → resync, reconnect with backoff 0.5 s → 30 s + jitter, ping/pong, no-data watchdog
- [x] Bybit v5 linear (`crates/connectors/bybit`): publicTrade + orderbook.200, snapshot / delta sequence check with re-subscribe on gap, ping 20 s, reconnect with backoff; REST instruments-info, book, recent trades; recorded-message tests (`bybit-linear:` feed, desktop only)
- [x] Shared connector framework (`crates/connectors/common`): WS driver (subscribe, heartbeat, reconnect 0.5 → 30 s + jitter, snapshot fallback), integer-tick L2 book with CRC32 checksum support, REST token-bucket rate limits, clock-skew correction, `MarketApi` trait; one-line venue registry in `market_cmds.rs`
- [x] Connectors: OKX swap (seqId + checksum), Binance spot / COIN-M / USDⓈ-M (rebuilt on the driver; proper aggTrades time-range backfill), Deribit (change_id chain; options chain via `market_options_chain`), Bitget v2, Kraken Futures, Bitfinex (spot + F0), Phemex, WhiteBIT; funding / open interest / liquidations as `MarketEvent::Stats` with `onFunding` / `onOpenInterest` / `onLiquidation` on the store; recorded-message tests for every venue
- [ ] Not run against live exchanges; stats not recorded in the tick store; Phemex / WhiteBIT gaps undetectable; short REST history on Phemex / WhiteBIT / Bitfinex; OKX / Bybit / Kraken / Phemex spot, OKX dated futures, BitMEX; quote / bookTicker event; Deribit chain not wired into the Options Board yet
- [!] Rithmic, CQG, dxFeed, Interactive Brokers, Tradovate, Alpaca — need user credentials / SDKs (see BLOCKERS)
- [ ] CSV / Parquet importer, "Custom WebSocket" JSON-mapping connector
- [x] Connections window (P32): per-connection status, latency colours, msgs/s, accounts, Connect / Disconnect / Edit / remove, Connect all / Disconnect all, auto-connect on start, summary cards; two-step add-connection wizard (provider tree with spec groups, FREE / YOUR ACCOUNT tags, per-type forms, Test connection, credentials in the vault)
- [ ] Providers without a connector show "Coming soon / requires SDK" (see BLOCKERS); simulator rows cannot be disconnected
- [ ] Acceptance: BTCUSDT 1-hour soak with zero sequence gaps (needs a Windows run with network access to Binance)

## P06 — History download & tick store

- [x] History merge (`market_history`): local store first, REST backfill only for uncovered gaps, written back to the store, de-duplicated at the seam; live stream buffered during history load so there is no gap or duplicate
- [x] `crates/tick-store`: per-instrument per-UTC-day trade and depth files, zstd columnar blocks of 1,000 records with CRC, block index, crash-safe (torn block ignored, index rebuilt), recorder thread (1 s flush, 10 s fsync; depth deltas, full snapshots, 250 ms top-25 snapshots), day compaction, retention by age / max disk, coverage file, CSV export; tick store registered as the preferred replay source
- [ ] Memory-mapped reads; bars cache; Parquet export; Bybit history beyond the latest 1,000 trades; Binance time-range backfill (reuses recent trades)
- [ ] Binance public archives (data.binance.vision) import
- [x] Data manager (ribbon + Connections tab): stored instruments, date ranges, per-day sizes, delete per instrument / day, trades / depth CSV export, recorder on / off, retention and max-disk settings
- [ ] "Set dates" dialog, "Reload all historical data"
- [~] Acceptance: 30 days of BTCUSDT into a 1m footprint in < 5 s — the store reads 2M trades in ~0.11 s (projects to ~4.7 s for 30 days, synthetic data); the UI path still sends history as JSON over IPC and aggregates in TypeScript

## P07 — Aggregation engine

- [x] Incremental + bulk bar builder (same code path), per-price clusters: bid vol, ask vol, total, delta, trades, max single trade
- [x] Time (seconds / minutes / hours / daily / weekly), Tick, Volume, Delta, Range bar types with the preset matrix
- [x] Property test: bulk vs incremental identical for every preset bar type (seeded data)
- [x] Bar types Range X / XV / Z / US (UniRenko-style), Renko, Reversal, Order Flow, Cumulative Trades; derived Heikin-Ashi, Point & Figure, Kagi, Line Break; every type a deterministic per-trade state machine (bulk = incremental = typed-array path); rules in `docs/ARCHITECTURE.md`
- [x] Timeframe dialog: rows × chips with disabled chips (feed capabilities), Configure (add / remove chips per bar type, pin favourites to the header), saved per user; custom chip rename pending
- [x] Sessions RTH / ETH / 24h / custom (open / close / time zone / days) applied to bars via catalog session rules; time-at-price per cluster
- [x] Acceptance: 10M ticks → M1 cluster bars ≈ 460 ms standalone (≈ 1.2 s with the full suite in parallel); benchmark test

## P08 — Chart engine core

- [~] ChartCore renderer: Canvas2D with dirty-flag redraw at most once per animation frame (**WebGL2 instanced renderer pending**)
- [x] Shared time axis, right price axis, auto-scale + manual drag on price axis, double-click axis reset, wheel = zoom time, Ctrl + wheel = zoom price, Shift + wheel = scroll, drag = pan, Shift + drag = vertical move
- [x] Crosshair with price / time tags, last-price line + coloured tag, bid / ask lines, session breaks with labels, dashed grid, OHLCV legend, debug overlay (render ms)
- [x] Mouse modes: Pointer, Crosshair, Zoom (drag box), Scroll, ZoomXY
- [x] Global / link-group crosshair sync with snap, resizable sub-panes (drag / reset / maximise), linear / log / percent / indexed / inverted scales, axis left / right / both, gaps on / off, per-chart time zone and 12 / 24 h, bar countdown (replay clock aware), watermark, high / low marks, session background, data window panel with layer values, lazy left-scroll history loading (simulated feed)
- [x] Display modes: Footprint modes (Alt+V / T / B / D), Bars, Candles, Transparent candles, Line, Area, Hidden (right-click → Mode)
- [x] Level-of-detail: footprint collapses to candles below 20 px slot width (configurable)
- [x] Window header: link-group dot, instrument, timeframe chips + menu, lots, template menu, Indicators (disabled), Live / Sim badge, snapshot camera (copy PNG), maximize, settings, close; bottom bar: go-to-latest, session selector, history info, DOM Trader, Trading Panel
- [x] Compare / overlay instruments (normalised %), Go to date (Ctrl+G, loads older history), pin (keeps instrument across link-group changes); lazy history and session filtering on live / replay feeds pending
- [ ] Acceptance: 8 charts at 60 fps with 1M ticks; Playwright test for every mouse mode / shortcut

## P09 — Chart templates

- [x] Built-in templates: Japanese Candlesticks with Volume Profile, Footprint chart, Liquidity Map, Order Flow (Dark) — switching re-renders from the same data
- [x] Order Flow (Light), Imbalance Chart, TPO Chart (letters / blocks, VA, POC, IB, single prints, split / merge), On-Chart Liquidity Map, Multi-timeframe Chart (boxes / side by side / stacked), Volume Histogram, Delta Profile, COT Chart (bundled sample data, labelled); per-template Style dialogs
- [x] User templates as JSON (`.httemplate`): save as / rename / duplicate / delete / overwrite / export / import, default per instrument class, favourites; style presets White, Light, Dark, Black, Dark footprint, Footprint statistic, Imbalance, MarketResearch, MultiTimeFrame

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
- [x] Standalone Heatmap module (`modules/heatmap`): quick-settings popover and a full settings dialog, gradient presets with a custom gradient editor, normalise per column, bubble styles (plain / pie / dominant) with tooltip, volume bars, large-order outline, order lifetime colours, left drawing toolbar, snapshot, reset view / settings
- [x] Order features: iceberg and spoof detection with tunable thresholds (ratio, min size, max life) and colours
- [x] 3D mode: three.js surface with a Canvas2D isometric fallback when WebGL is not available; colour and camera controls
- [x] `heatmap.*` settings wired into the window; palette commands (toggle 3D, quick settings, full settings, normalise, volume bars, stress test, reset view / settings, snapshot, objects)
- [x] Tests: model and detector tests, benchmark, CL-like stress feed
- [ ] Acceptance: CL-like replay at 30 fps on a real Windows machine (the stress test and a light perf smoke test exist; not measured on hardware)

## P12 — Drawing tools

- [x] Side-tool groups list every tool with its shortcut (Lines, Shapes, Volume Analysis, Fibonacci, Measurement, Elliott, Markers, Text, Positions, Gann & Pitchfork, Objects); tools are live
- [x] 67 drawing tools on a shared `@htflow/drawings` package (model, time axis, geometry, controller, history) attached to every chart as a chart extension; drawings persist per window and across layout tabs
- [x] Anchors with drag editing, magnet (off / weak / strong presets), lock / hide / clone / delete, style toolbar (colour, width, dash, fill, text), extend left / right, per-timeframe visibility, sync across linked charts, Objects List window, Undo / Redo history, hotkeys
- [x] Alert on cross for lines, rays, channels and rectangles (cross / enter / exit), bell toggle + dialog, fires through the alerts runtime; emoji picker; regression inner / outer σ and anchored-VWAP band fields; magnet slider (px) in Drawing preferences; multi-select (Shift+click, Ctrl+drag box, Ctrl+A) with group move / delete / style
- [x] ZigZag volume profile, CVD correlation, Magnifier (M), Remove indicators; Ctrl+Z / Ctrl+Y / Del / Ctrl+A registry commands; drawings on both Order Flow (Dark) panes; Objects List ribbon button
- [ ] i18n of drawing strings; registry Ctrl+Z needs the last pointer-down inside a chart

## P13 — Indicator framework

- [x] Indicator SDK (`@htflow/indicator-sdk`): metadata, typed inputs with validation, line / step / area / histogram / band / dots / bars / markers / levels / zones outputs, sources incl. delta / CVD / clusters, incremental calc (full on replace, last bar on append)
- [x] Indicators dialog: categories with counts, search, favourites, pending badges, on-chart list (eye, reorder, duplicate, remove), settings tabs Inputs / Style / Visibility / Advanced, presets, reset, apply to all charts, live preview with Cancel; Ctrl+I, header chip, chart menu
- [x] On-chart canvas legend (value at cursor, eye / settings / remove), stacked sub-panes with own scales (max 60% height), overlay / new / shared pane
- [ ] Alerts tab (placeholder), timeframe override (MTF), drag to pane by mouse, overlay other symbol, custom-script editor and `.htind`, worker pool / Rust WASM path

## P14 — Indicator catalog (280+)

- [x] All 281 Appendix B entries catalogued (`docs/INDICATORS.md`): 262 implemented (181 distinct implementations, the rest are presets and multi-timeframe wrappers); each tested against hand-computed values and incremental = full recompute
- [x] SDK feeds (funding, open interest, liquidations, depth) and a multi-timeframe wrapper (last closed bar or forming bar)
- [ ] 19 pending entries: Options Board, Options Position, Volatility Smile and Options Risk Profile need an options-chain provider in the SDK; four COT entries need a CFTC data source; Account Info Display and Position Sizing Tracker need account data in the indicator context; Spread, Ratio, Correlation and Beta need a second-instrument input; Custom Formula needs an expression editor; Custom script (`.htind`) needs a code editor; Market Profile & TPO is a chart template (P09); CMS and Margin Zones are not defined in Appendix B

## P15 — Smart DOM

- [x] DOM ladder (board 24): Orders / PnL, Today (session volume), Price, Chg., Bid, Sells, Buys, Ask, Chg. — canvas renderer
- [x] Auto-centre with manual scroll (wheel) and re-centre (double-click / C), price grouping 1 / 2 / 5 / 10, depth bars, current price row, spread line
- [x] One-click trading: left-click = buy limit, right-click = sell limit, Ctrl = stop; click Orders column = cancel at price; footer: reverse, cancel all / bids / asks, MKT buy / sell, Flatten all, Trading Panel, lock trading
- [x] DOM Trader: compact DOM docked right of any chart (bottom-bar toggle)
- [x] Smart DOM v2 columns: toggle / drag reorder / resize / per-column colours; volume at price (session or rolling), last trade size, delta at price, Σ bid / Σ ask, price notes, limit tracking with queue estimate, stops / iceberg markers, VA / POC, P&L at price, pulled / stacked flashes; drag-to-modify orders, grouping, centring modes
- [x] 13 templates (Basic Extended … Prop DOM with risk strip) + template designer (columns, style, behaviour; JSON import / export); ~75 palette commands
- [x] Acceptance: 20 updates / ms bursts, model + full 18-column draw: mean ≈ 0.5–1.4 ms, p95 ≈ 1–6 ms per frame (budget 16.7 ms); benchmark test

## P16 — Smart Tape, Bid/Ask Tape, All Prices

- [x] `@htflow/tape`: typed-array ring buffer, smart-print aggregation (same timestamp / time window / off) with VWAP, high / low, fill count, bid / ask, CVD; filters, auto size buckets, big-print threshold, prints/s and volume/s
- [x] Smart Tape (canvas, hideable columns, size-bucket colours, big-print highlight and sound, pause on hover, wheel scroll-back, filters panel), Bid/Ask Tape (split sells / price / buys, size chips, speed meter), All Prices (virtualised, sortable, volume bar, delta, time-at-price heat, POC, Session / Visible / Week, row grouping); follow the active chart / DOM or pick an instrument
- [ ] Strings through i18n; measured 5,000 prints/s frame rate; Visible range is a rolling window (no chart visible-range API yet)

## P17 — Trading Panel, orders & paper engine

- [x] Trading Panel (board 02): account selector with masked id + eye toggle, qty with lot presets, BUY / SELL MARKET, BUY / SELL ASK, BUY / SELL BID, Cancel Bids / Asks / All, Reverse, Breakeven (H), Close, PnL, position / entry, OCO, TIF (GTC / DAY / IOC / FOK / GTD), Reduce-Only, SL / TP toggle with TP / SL ticks; toggle with T
- [x] Paper engine: market orders walk the live book (partial levels), limits rest and fill when the tape trades through, stops trigger on last trade, IOC / FOK, reduce-only, lock trading, commissions, realized / unrealized PnL
- [x] Brackets with multiple targets: SL + N take-profits (OCO), stop shrinks as targets fill, stop fill cancels targets
- [x] Trading from chart: right-click Buy / Sell Limit or Stop at cursor price
- [x] Order types: iceberg (display qty, refills), MIT, trailing stop (ticks / % / ATR, tightens only), stop-limit; per-account slippage on triggered orders; separate maker / taker fees (maker rebates allowed)
- [x] ATM templates (`packages/trading/src/atm.ts`): SL ticks / $ / % / ATR / trailing, up to 8 weighted targets in $ / % / points / ticks, auto-breakeven, trailing steps, 5 presets; ATM & Trading Setup window (editor, JSON import / export); picker in Trading Panel, DOM and DOM Trader
- [x] Chart trading (chart extension): position line with live P&L and ✕ close, draggable working-order and SL / TP lines with ✕ cancel, B / S fill markers, right-click order menu; all styles configurable
- [x] Multiple paper accounts (create, rename, starting balance and currency, reset, delete); order confirmations per order type; account picker shows the routed account (replay); minimal options positions model in the engine
- [ ] Chart right-click Buy / Sell and Dashboard Flatten / Breakeven still use the default paper account without ATM; risk engine covers the default account only; options model not connected to the Options Board; saved accounts keep settings, not balances / positions; OCO checkbox inert
- [x] Tests: bracket with 3 targets fills correctly; PnL matches hand calculation

## P18 — Options Board & analytics

- [x] `@htflow/options`: Black-Scholes (dividend / funding yield) and Black-76 with full Greeks, IV solver (Newton + bisection), strategies (payoff at expiry and T+n, breakevens, max profit / loss incl. unlimited, probability of profit, Greeks totals), 13 templates, simulated chains for all Sim instruments, Deribit provider (recorded-fixture tests); validated against Hull / Haug references within 0.5%
- [x] Options Strategy Analyser window: series filters, expiry blocks (calls / strike + IV / puts, ITM tint, spot line), click bid to sell / ask to buy, strategy builder with canvas payoff chart and T+n slider, readouts, local options positions tab with live P&L
- [ ] Options not modelled by the paper engine (local positions only); Appendix B options indicators exported but not on charts yet; live Deribit in the desktop app needs `net_fetch_text` (now merged) wiring check; CME options need a user feed

## P19 — Forward curve

- [x] Forward Curve window: CL / NG / GC / ES / BTC (CME) / BTC quarterly, expiries from catalog roll rules, compare to 1 / 7 / 30 days ago, contango / backwardation badge, calendar spreads, basis and annualised basis, next roll; `registerCurveProvider()`
- [ ] Real prices: simulated term structure (Sim badge) until a futures feed or quarterly crypto connectors exist

## P20 — Tables group

- [x] Accounts (masked ids, risk pill, total equity), Positions (Close / Reverse / Flatten all), Orders (OCO marker and group, Modify, cancel / cancel all), Trades (ms time, commission, realized) on a shared virtualised DataTable: column chooser, sort, per-column filters (text and `>` / `<=` / `=`), grouping, saved views, CSV export
- [ ] XLSX export; inline order modify (price prompt today); Connect account button (no broker connector yet)
- [x] Trading Activity: fills, brackets, cancels, rejections, locks / unlocks, risk warnings, alert firings, connection errors; 90-day / 5,000-event rolling log per user; `activityLog.add()` API
- [x] Trading Journal (P36): R multiple, expectancy ($ and R), long / short win rate, break-evens, commission, max DD ($, %, date), best setup, equity curve with drawdown, calendar heatmap, MAE / MFE from the tape, tags / notes / rating / image attachments, manual entries, CSV export; validated against 500 paper trades
- [x] Automatic chart snapshots at entry / exit attached to journal trades (per chart: strategy trades / all / off); backtest trades import into the journal tagged `backtest`

## P21 — Market analytics tools

- [x] `@htflow/analytics` with shared ref-counted per-instrument engines (1 s refresh, up to 200 symbols): Market Pressure (buy % 1m / 5m / 15m / session, thresholds), Price Change (% / ticks / $, range position, VWAP distance, sparkline), DOM Pressure (±5 / 10 / 25 ticks, imbalance, pull flash), Delta Divergence (M1–H1, HH / LH and LL / HL vs CVD, optional absorption); sortable, persisted, optional toast + beep, row click sets the active chart
- [ ] Shared Rust scanner (computed in TypeScript today, CPU target unmeasured); scroll chart to the signal bar; session start is 00:00 UTC; alerts not linked to the Alerts module

## P22 — Info group

- [x] `@htflow/info`: XML / RSS 2.0 / RSS 1.0 / Atom / OPML / ICS parsers, keyword highlighting, symbol tagging, calendar logic, reader cache, own-event detectors (big prints, delta spikes, liquidity pulls), `.htidea` format; Rust `net_fetch_text` (GET, 15 s, 5 MB cap, no cookies)
- [x] RSS Reader (folders, unread, reading pane, open chart, OPML, keywords, refresh interval, offline cache), News (RSS + own events + calendar, filters, keyword alerts), Economic Calendar (impact filters, countdown, ICS URLs, actual vs forecast colours, vertical lines on charts, alert N min before), TradersTalk (local idea log with snapshots, `.htidea` export / import)
- [ ] Default feed URLs unverified; RRULE recurrence not expanded; "Open in Web Pages" (window not built); funding / OI / liquidation events (no connector data); TradersTalk sharing, chat and sync need a server (BLOCKED); bundled data is labelled sample

## P23 — Alerts & Risk Management

- [x] Risk engine (P41): daily loss (flatten + lock to next day), trailing drawdown, max position per instrument, orders per minute, trades per day, trading hours with time zone, profit target; 80% warnings; prop-firm / conservative presets; hashed override password; locks survive restart; title-bar meter shows Locked
- [x] Alerts (`@htflow/alerts`): price cross, big trade, bar delta, DOM level within N ticks, connection lost; count / expiry / cooldown; popup, beep, desktop notification, activity log; Alerts window; chart right-click "Set alert" and alert lines
- [ ] Indicator / drawing / liquidation / funding alert conditions, Telegram / Discord, flash window, custom sound; news-flatten has a hook but no calendar feed; risk covers paper accounts only

## P24 — Replay

- [x] `@htflow/replay`: deterministic engine (trades, book snapshots / deltas, keyframes), 0.25×–1000×, step tick / bar / back bar, jump to time, loop, bookmarks, multi-instrument synced groups; sources: simulator history, in-memory store history, pluggable `registerReplaySource()` for the tick store
- [x] `replay:` feed provider (purple Replay badge / status pill), Replay window (setup, templates, replay paper account with tag routing), chart control bar (P35) with timeline, speeds, Go to time, bookmarks, Sync, Loop; Space / arrows / 1–7 hotkeys
- [x] Hide future bars toggle with ghost candles (never fed to the store), fills stamped in replay time (`PaperEngine.setClock`), B / S fill tags, economic-event markers on the timeline, bookmarks and loop saved per template, Replay window opens in its own split
- [ ] Missing-data download

## P25 — Workspaces, layouts, linking

- [x] Workspace saved per user (encrypted settings): every window's state + dockview layout; autosave on change and every 60 s; restore on start
- [x] Layout tabs at the bottom (each tab = saved layout), add / rename (double-click) / close
- [x] Link groups (none / red / green / blue / yellow / purple): changing the instrument in one window changes the whole group
- [x] Workspaces manager window and ribbon / title-bar menu: save, save as, rename, load, duplicate, delete, export / import; library with autosave; 8 starter workspaces (Scalping NQ, Crypto Flow, Futures, Multi-Chart 2×2, Heatmap + DOM, Options Desk, Analysis, Replay practice); palette command for each action
- [x] `.htworkspace` files (`@htflow/workspace`): versioned JSON envelope (v1 → v3 migrations), validation with warnings, tested
- [x] "Create linked window" and "Clone window" from the window ⋯ menu (charts, DOM, tape and module windows); Float / Dock
- [x] Multi-monitor restore: windows are placed on the monitor that held them and moved on-screen when that monitor is gone (setting `layout.restoreMonitors`)
- [ ] Opening a workspace in a separate OS window (see BLOCKERS)

## P26 — Chart right-click menu

- [~] Buy Limit / Sell Stop (or Sell Limit / Buy Stop) at cursor price, Trading Panel, DOM Trader, Mode ▸ (Footprint modes, Bars, Candles, Transparent, Line, Area, Hidden), Mouse ▸, Reset, Export PNG — Go to date, Change instrument, Templates ▸, Indicators, Overlay, Drawing objects ▸, Chart strategies, Layouts ▸, Create linked window, Clone, Hide panels, Trading session ▸, Refresh, Reload history, Add replay template, Export CSV / JSON, Full screen, Settings pending; context-aware menus pending

## P27 — Settings & customization centre

- [x] Typed settings store (82 settings: defaults, validation, help, reset per setting / section / all, modified markers), saved per user, JSON export / import with per-key validation; `useSetting` / `getSetting` / `onSettingChange` API
- [x] Settings window (Ctrl+,, palette, "Settings: <section>"): search, draft with Cancel / Apply / OK; General, Appearance (5 themes, 29-token editor, UI scale, font size, icons-only ribbon, theme JSON), Hot keys (record, conflicts, scopes, presets, export / import), Sounds (7 events, volume, preview, own .wav / .mp3), Time zones (exchange clocks and trading hours), Commission (rules by account / instrument, applied to paper trading), Data delays (status-bar pills), Performance (FPS overlay), Common settings groups
- [x] Settings wired: date format / 24h / app time zone in tables, journal, tape and divergence; first day of week; start-up workspace; autosave; confirmations (flatten, close window, exit, table actions); notifications show / duration / max; DOM levels, row height, auto-centre, big lot; tape ms; RTL flag; clear caches on logout; log level and buffer size
- [x] Sections Chart, Footprint, Heatmap, DOM, Tape, Trading, Data, Alerts, Risk, Privacy & security (telemetry off, clear caches / logs, reset all), Logs (viewer), Custom modules (P43: enable / disable modules, module folders placeholder), About & updates (licences, links); about 150 new keys; RTL preview flag
- [ ] Chart / footprint / heatmap / trading / data / alerts / risk keys are defined but not yet read by those modules (`wired: false`); max candles and default load days not wired; mask accounts / hide balances / number format stored only; native log files, settings folder, module-folder loading and updater need the native core; per-chart Settings (Ctrl+S) in progress; languages other than English

## P28 — Remaining modules

- [x] Web Pages (tabbed iframe browser, bookmarks, claims `htflow:open-url` in the web build), Logs (in-app ring buffer capturing console errors and unhandled rejections; level / source filters, search, pause, copy, export, clear), User Guide (18 searchable articles, shortcuts table, F1), guided tour (once per profile, restartable from the palette), "Load sample replay session" (fixed seeded hour on CLZ6)
- [~] Following Manager: full UI with a local list and sample feed; sharing and sync BLOCKED (needs a server)
- [x] Strategies (P42): `@htflow/strategy` SDK (typed inputs, onBar / onTrade / onBook / onFill, indicators, footprint helpers, order API with brackets / trailing / ATM), 5 example strategies, deterministic backtester on replay datasets with slippage / commission, Sharpe / Sortino / Monte-Carlo DD, grid optimiser (Web Worker) with heatmap and walk-forward; Strategies window; chart strategies with markers and live paper trading
- [~] VPS runner: UI with demo runner and protocol spec in `modules/strategies/README.md`; BLOCKED (needs your own runner binary + SSH transport)
- [ ] Web Pages in the desktop app needs a native child webview (links open in the system browser); strategy code editor, `.ts` / `.py` / `.htstrat` loading, Python runner, no-code rule builder

## P29 — QA, performance & hardening

- [x] Local crash reporter: panic hook and UI error boundary write redacted reports to `<data>\crashes\`; nothing is sent anywhere; unit tests
- [x] `docs/SECURITY.md` (threat model, network surface, checks)
- [ ] Full audit, benchmarks vs targets, 8-hour soak, accessibility pass
- [x] CSP set for the WebView; IPC allow-list via Tauri capabilities; secrets never logged (Debug impls redact)

## P30 — Windows installer & release

- [x] NSIS per-user installer (no admin) built in CI; app icon (original artwork)
- [x] MSI (WiX) next to the NSIS installer; portable zip (`HT Flow.exe` + `portable` marker, data in `data\` next to the exe)
- [x] File associations (.htprofile, .htworkspace, .htind, .htidea, .httemplate); opening a file starts HT Flow or hands it to the running instance
- [x] Uninstall asks whether to keep or remove user data (updates always keep it)
- [x] Updater via `tauri-plugin-updater` and `latest.json` from GitHub Releases; Stable and Beta channels (Beta reads a rolling `beta-channel` release); Command Palette "Check for updates"; only active when signing secrets are set
- [x] Release workflow (uploads into a draft, then publishes), installer smoke test, `docs/RELEASE.md`, release notes, code-signing notes
- [ ] Updater signing key (`TAURI_SIGNING_PRIVATE_KEY`) and code signing — see BLOCKERS

## Section 6 — Live pipeline

- [x] Stage 1 Connect (Binance Futures) · [x] Stage 2 Normalise (ticks) · [x] Stage 3 Book builder with sequence check
- [~] Stage 4 Event bus — bounded channel per subscription; slow consumer never blocks the socket (drops to snapshot mode); lock-free ring buffer pending
- [x] Stage 5 Recorder (tick store)
- [~] Stage 6 History merge — history then live on one chart; gap detection, dedupe at the seam and lazy left-scroll loading pending
- [x] Stage 7 Aggregator (shared series per instrument + bar type) — in TypeScript on the UI side today
- [ ] Stage 8 Indicator engine (worker pool)
- [~] Stage 9 UI streamer — 16 ms coalescing per subscription; hidden-window suppression and binary payloads pending
- [~] Stage 10 Render — Canvas2D, redraw only when dirty (WebGL2 + SDF text pending)
- [~] Stage 11 Actions — paper engine fills from the live book + tape; alerts / risk pending
- [~] Stage 12 Observability — msgs/s, latency (EWMA), connection state per feed in the status bar and Connections window; p50 / p99, gaps counter in UI pending

## P31–P43 — Detailed window specs

- [~] P31 Trading workspace v2 — template switch keeps zoom; legend lines; session separators; stats rows; DOM Trader; status pills per connection. Pending: Snapshots in template menu, "Load days", "◂ Load 1 more day", previous-session profile on the left
- [x] P32 Connections window — see P05
- [x] P33 Chart types — all template renderers plus Renko, P&F (X / O), Kagi, Line Break, Heikin-Ashi, range variants
- [x] P34 Chart settings window (Ctrl+S): Visual / Footprint / Trading / Templates tabs, ~150 rows, live apply, Cancel reverts, JSON export / import; global Settings act as defaults
- [x] P35 Chart Replay control · [x] P36 Trading Journal window · [x] P37 Workspaces / templates / layout settings windows · [x] P38 Market analytics windows · [x] P39 RSS / News / Calendar · [x] P40 tables (see P20) · [x] P41 Alerts / Risk / Watchlist / Forward curve (Sim prices) · [~] P42 Strategies + backtests done, VPS runner blocked · [~] P43 Common settings (hot keys, sounds, time zones, commission, custom modules page done; languages pending)

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
