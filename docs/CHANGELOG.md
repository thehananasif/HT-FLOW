# Changelog

## Unreleased — round 5

### Added

- Older history on live charts in the desktop app (P05 / P06, fixes "Binance previous data is not showing"): new `market_history_range` command behind "Load days", "◂ Load 1 more day", left-scroll and Go to date. It walks the range newest-first: local tick store, then the history cache, then REST trades for the last day paged backwards (Binance spot / USDⓈ-M / COIN-M by aggTrade id, OKX `history-trades`, Bitget / Bitfinex / Deribit windows) within a per-call request budget, then Binance klines (interval picked per span, at most 5,000 bars) rebuilt as bar-level ticks with exact OHLC / volume / delta — so 4 h / 1 D charts load in one cheap request and open with at least 120 bars. HTTP 429 / 418 / 503 answers honour `Retry-After` and are reported; the chart footer shows download progress ("rate limited, slowing down" when throttled).
- Settings → Data → Cache size is wired: a size-capped on-disk history cache (`<data>/cache/history`, LRU eviction, survives restarts) holds closed hours of downloaded trades and kline chunks.
- Settings → Data → Provider priority is wired (UI-side mapping): when a catalog instrument is offered by several feeds, connected providers win first, then the list order, then live > delayed > sim > replay; providers missing from a saved list rank before the simulator. The list now names every built-in live venue.

- Settings wired (P27, round 5): DOM font size, default price grouping of new DOMs, Buys / Sells window and swapped left / right click; Tape rows kept, minimum size, follow new trades, big-trade threshold, colour by side and beep on big trades; chart-axis and calendar / news time zones and exchange time on hover in tables and journal; FPS cap (charts, DOM, tape), renderer type and video adapter (3D heatmap); recorder disk budget and tick retention pushed to the native recorder. MBO history, backups and log files stay pending on native work (BLOCKERS).
- CSV importer in the Data manager: trades or OHLCV bars from a user-picked file with auto-detected delimiter, header, columns, time format (epoch s / ms / us / ns, ISO, d/m/y), time zone and side meaning, a preview of the first rows, rejected rows listed with line numbers, chunked streaming, and import to a `csv:` instrument that opens in charts and Replay.
- "Custom WebSocket" connector in the Add-connection wizard: ws(s):// URL, `{symbol}` subscribe template and a JSON path mapping (price, qty, side, timestamp, optional book), reconnect with back-off, status in the Connections list, wizard test against the first message.
- Paper accounts keep their open state across restarts (P17): positions, working orders (with OCO groups and pending ATM brackets), live ATM management and options positions are saved with the cash balance in the encrypted profile store (`PaperEngine.exportAccountState` / `importAccountState`, validated by `normalizeAccountState`). The latest state is flushed before the window closes. Restoring re-bases both risk layers (`RiskEngine.snapshotDay` / `restoreDay`, Settings → Risk day counters): the same trading day continues its day P&L and trade count, another day starts at the restored equity, so a restored balance is never mistaken for a loss made today.
- OCO in the Trading Panel works (P17): with OCO ticked, every resting order sent from the panel (order entry, BUY / SELL ASK / BID) joins one group; the first fill (even partial) or cancel cancels the other orders. Status line with "New group", OCO badge on working orders, OCO line in the order confirmation; commands "Toggle OCO", "Start a new OCO group" and "Link the last two working orders as OCO". Engine: `OrderRequest.oco`, `ocoGroupId()`, `linkOco` / `unlinkOco`; bracket SL / TP groups keep their own rules.
- Paper options (P18): the Options Board trades options in the paper engine. "Send as paper order" books every leg, and a new "Click a quote: Add leg / Trade now" setting buys at the ask or sells at the bid at once. Premium debit / credit is recorded per fill (`premiumFlow`), positions are marked to model with `@htflow/options` pricing (`paperOptionMark`: Black-Scholes, or Black-76 on spot × the expiry's forward basis, the position's IV and rate) and settle at intrinsic value when they expire (`settleExpiredOptions`, logged in Trading Activity). Options appear in the Positions table (OPT pill, model mark, open P&L, Close; Flatten all closes them), in account equity and the risk engine, and in the Options Strategy Analyser's positions tab (debit / credit, mark, P&L, days left, Analyse loads them into the builder, Close). Strategies saved by the old local model stay listed as "Saved strategies".

### Changed

- Drawing tool names and descriptions are translated through i18n (`drawings.tool.<id>`, `drawings.toolDesc.<id>`, group keys `drawings.menuGroup.*` and `drawings.toolbarGroup.*`). `@htflow/drawings` keeps its English labels as data; the UI layer (`modules/drawings/toolText.ts`) resolves them in the toolbar, Objects List, command palette, alerts and heatmap toolbar. English text is unchanged.
- Chart right-click menu strings (`charts/menu.ts`) go through i18n under `chartMenu.*`, with interpolated labels for pane, limit/stop order and overlay items. English text is unchanged.
- `drawingName` in `@htflow/drawings` takes an optional label resolver, used by the Objects List.

### Tests

- `modules/drawings/toolText.test.ts`: every drawing tool has a translated name, every tool with a note has a description key, and English output matches the package labels.

### Fixed

- Charts no longer freeze on 4 h (or 1 h, 1 D, 1 W): with few bars the view always counts as "scrolled past the first bar", and every redraw asked the feed for 240 bars of older history (40 days ≈ 28M simulated ticks for 4 h), then looped. Lazy left-scroll loading now starts only after a user scroll, asks for a capped chunk (2 h on simulated feeds, 1 day on live / replay), shows progress, and is cancelled when the timeframe changes; Go to date loads at most a day per step. Regression e2e `timeframe-coarse.spec.ts` (first paint under 1 s, no long tasks) and unit tests.

## Unreleased — round 4

### Added

- Command Palette (Ctrl+K) searches indicators: every implemented catalog entry is listed under an "Indicators" header and adds itself to the active chart, as the Indicators dialog's "+" does. Pending entries are not listed.
- Command Palette searches settings: every settings section and key is listed under a "Settings" header; choosing one opens the Settings window at that section. Command results stay first.
- Instrument Picker rows can be dragged: drop on a window to change its symbol (modules keep it in their params), Ctrl+drop or drop on an empty dock area opens a new chart window (`dashboard/instrumentDrop.ts`, e2e `picker-drag.spec.ts`).
- Watchlist "OI / Funding" column shows open interest and funding rate from the crypto connectors' stats streams, "—" when the feed has none.
- Continuous-contract roll by volume: `frontContract` / `nextRoll` / `Catalog.frontCode` accept per-contract volumes and, for `volume` roll specs, roll as soon as the next contract trades more; without volume data the date rule applies.
- Search index rejects non-matching entries with a whole-entry character mask; a vitest benchmark asserts < 50 ms on 10,000 generated instruments.
- ui-kit `Table`: column resize and reorder with per-table persistence (`tableId`, setting `common.tableLayouts`, reset command and Settings editor); ui-kit `Popover` with portal rendering and flip / shift positioning.
- Tables (P20): XLSX export from every table's menu (own minimal OOXML writer, no new dependency) and inline order modify (edit price / qty in the Orders table, Enter applies).
- Alerts (P23): funding-rate conditions (rate ≥ / ≤ / |rate| ≥, in %) and liquidation conditions (single print or rolling 1 / 5 / 15 min sum, longs / shorts) fed by the crypto connectors' funding and liquidation streams.
- Alerts (P23): generic `indicator` value condition (crosses above / below, ≥ / ≤) fed with `pushValue()`; public API `modules/alerts/api.ts` (`addAlert(condition, options)`, `removeAlert`, `listAlerts`, `pushValue`, `testAlert`, `setAllEnabled`) for the Indicators dialog and other modules.
- Alerts (P23): new actions Flash window (taskbar flash on desktop + flashing title), Telegram and Discord (user's own bot token / webhook, kept in the encrypted vault; validation, "Send test", 20 sends / min throttle, secrets redacted from errors); per-alert sound with built-in sounds or a local sound file added to the profile; ▶ Test button per alert; palette commands Alerts: Open / Pause-resume / Enable all / Disable all / Send test.
- Risk (P23): "Apply to all paper accounts" saves rules to every paper account and makes them the defaults for new accounts; news-flatten is fed by the Economic Calendar (high-impact timed events; SAMPLE events only when "Count SAMPLE events" is on); feed status line in the Risk window.
- Indicators (P13): Alerts tab (output vs level or another output, intrabar / bar close, once, toast / sound / log via the Alerts module), timeframe override for any indicator, another symbol as data source, drag an indicator to another pane by its legend title.
- Indicators (P13 / P14): HT Script — sandboxed indicator language (interpreter, no eval / globals / DOM / network), Script Editor window with live error line, per-user library, `.htind` export / import and file association; Custom Formula and Custom script catalog entries implemented (264 of 281).
- Stage 8: indicator engine worker pool (`IndicatorPool`, `EngineHost`, `RemoteRuntime`); setting "Compute indicators in background workers"; `performance.workerCount` is now wired.
- Chart right-click menu (P26) completed in the spec order: Buy / Sell at cursor, Set alert, Trading Panel, DOM Trader, Lock trading, Go to date, Change instrument, Mode ▸, Mouse ▸, Templates ▸, Indicators, Overlay, Drawing objects ▸, Chart strategies, Layouts ▸, Create linked window ▸, Clone window, Hide panels, Trading session ▸, Refresh, Reload all historical data, ◂ Load 1 more day, Add replay template, Reset, Export ▸, Full screen, Settings. Extension items are placed in their spec slots (`charts/menuSlots.ts`).
- Context-aware chart menus: on an indicator legend row or indicator sub-pane → Indicator settings / Hide / Remove / Move to pane ▸ (price pane, new pane, pane up / down); drawing and order-line items now come first; price / time axis menus unchanged.
- Chart right-click Buy / Sell orders go through the shared order path: the account picked in the Trading Panel, its selected ATM bracket and order confirmations. The price falls back to the pointer when no crosshair is set yet.
- P31: Snapshots submenu at the top of the chart template menu (take snapshot of the whole chart state, restore, delete, copy PNG; saved per profile); per-chart "Load days" (default from Settings → Common → Default load days, now wired) with background loading for real / replay feeds; "◂ Load 1 more day" button, menu item and command; previous-session volume profile on the left of candle and footprint charts (POC highlighted, value area tinted, POC price label; Chart settings → Grid toggle).
- Commands: Chart: ◂ Load 1 more day, Chart: Take snapshot, Chart: Lock / unlock trading.
- Footprint quick settings (P10): colours of every element, filters (min volume, min |delta|), presets (built-in + save / load / delete per user), value area per bar, horizontal imbalance, absorption markers, cell colouring / opacity, min row height and a cumulative-delta statistics row; palette commands for the dialog and built-in presets.
- Settings wired (P27): Chart, Footprint, Trading, Data, Risk and Privacy keys now change behaviour live (new-chart timeframe / footprint mode, auto-scroll, wick / border colours, crosshair labels, magnet, status line; default qty / sizes / order type / TIF, one-click, order hot keys, slippage guard, auto bracket, order / position lines, confirm orders; feed conflation, local timestamps, re-subscribe back-off, recorder switch; app-wide risk limits with warn / block / flatten and lock duration; masked accounts, hidden balances, number format). Provider priority, cache size and default load days stay pending on native work (BLOCKERS).

### Changed

- Window-scoped hotkeys (Ctrl+Z / Ctrl+Y / Del / Ctrl+R / Shift+B…) fall back to the active window when the last click was outside any window (status bar, ribbon, a closed menu).
- Chart full screen no longer defaults to F11 (F11 is the Triangle drawing tool per Appendix C); Ctrl + double-click stays the default, a key can be bound in Settings → Hot keys.
- Long menus scroll within the window instead of running off screen.
- Discord alerts work in the desktop app: new native `net_post_json` command (https only, Discord webhook hosts only, 64 KB body cap, 15 s timeout, no cookies).
- Drawing "Alert on cross" now runs inside the Alerts engine (`drawing` condition): drawing alerts are listed in the Alerts window, use all alert actions, keep working while the chart is hidden, and deleting one there turns the drawing's flag off.
- Settings → Alerts keys are wired: master switch, pop-up, flash title, default repeat / expiry / cool-down for new alerts, maximum active alerts.
- Saved alerts are validated on load (`normalizeAlerts`); older saves get defaults for the new action flags.
- Dashboard Flatten all / Breakeven, chart right-click Buy / Sell and the title-bar risk meter use the selected paper account (not always the default one); the Risk window opens on the selected account.
- Paper accounts keep their cash balance across restarts (open positions are not saved yet); risk rules and locks of non-default accounts survive restarts (they used to be dropped when the account loaded after the risk settings).

## Unreleased — round 3

### Changed

- Drawing toolbar, menus, dialogs, Objects List and toasts, and the Smart Tape / Bid-Ask Tape / All Prices strings now go through `@htflow/i18n` (English text unchanged).
- Smart DOM benchmark asserts the spec's 60 fps budget at p95 (16.7 ms) and a mean under 4 ms, instead of a p95 under 8 ms that failed only under CPU contention.
- "Binance" in the Connections catalog now means Binance spot; "Binance COIN-M" is a new entry.
- Paper maker fills now pay the maker fee (taker rate if unset) instead of half the taker rate.
- Positions / Orders row actions and Flatten all / Cancel all ask for confirmation by default (Settings → Common → skip table confirmations).
- Indicators (P14): catalog now has 262 of 281 entries implemented (was 143 usable). 19 stay pending (see `docs/INDICATORS.md`).

### Fixed

- Command Palette focuses its search box in the same commit that opens it, so keystrokes no longer reach the chart underneath.

### Added

- Heatmap (P11): standalone Heatmap module with quick settings, full settings, gradient presets and editor, per-column normalisation, bubble styles, volume bars, iceberg and spoof detection, left drawing toolbar, 3D mode (three.js with an isometric Canvas2D fallback), wired `heatmap.*` settings and palette commands.
- Workspaces (P25 / P37): Workspaces manager window and menu (save, save as, rename, duplicate, delete, export / import), `.htworkspace` files with validation and migrations, library with autosave, 8 starter workspaces, Layout Settings window with `layout.*` settings, Create linked window and Clone window, multi-monitor restore.
- Indicators batch 2 (P14): 119 new indicator entries, SDK feeds (funding, open interest, liquidations, depth) and a multi-timeframe wrapper.
- Installer and release (P29 / P30): MSI next to the NSIS installer, portable zip, file associations (.htprofile, .htworkspace, .htind, .htidea, .httemplate), keep / remove data prompt on uninstall, updater with Stable and Beta channels (active only when signing secrets exist), release workflow, installer smoke test.
- Local crash reporter with redaction (nothing is sent), `docs/SECURITY.md` and `docs/RELEASE.md`.
- Drawings and replay gaps (P12 / P24): alert on cross, multi-select, emoji picker, magnet slider, new tools (ZigZag VP, CVD correlation, Magnifier, Remove indicators), drawings on both Order Flow panes; replay ghost bars, replay-time fills, B / S tags, calendar markers, per-template bookmarks, own split.
- Chart engine v2 (P08 / P26 / P34 / P09): crosshair sync, resizable panes, log / % / indexed / inverted scales, gaps, per-chart time zone, countdown, watermark, high / low marks, compare overlays, data window, Go to date, pin, lazy history; Chart Settings window (Ctrl+S); JSON chart templates and style presets; context-aware chart menu.
- Chart types and aggregation (P07 / P33 / P09): Range X / XV / Z / US, Renko, Reversal, Order Flow, Cumulative Trades, Heikin-Ashi, P&F, Kagi, Line Break; sessions applied to bars; time-at-price; timeframe dialog with Configure; Order Flow (Light), Imbalance, TPO, On-Chart Liquidity Map, Multi-timeframe, Volume Histogram, Delta Profile and COT (sample data) templates.
- Smart DOM v2 (P15): 18 configurable columns, 13 templates, template designer, notes, iceberg and pulled / stacked detection, drag-to-modify orders.
- Crypto connectors (P05): shared driver framework; OKX, Binance spot / COIN-M, Deribit (with options chain), Bitget, Kraken Futures, Bitfinex, Phemex, WhiteBIT; funding / open interest / liquidations streams; Binance time-range backfill.
- Strategies (P28 / P42): strategy SDK, 5 example strategies, deterministic backtester, optimiser with heatmap and walk-forward, Strategies window, chart strategies, journal snapshots; VPS runner UI (blocked).
- Trading v2 (P17): iceberg, MIT, trailing stop, stop-limit; ATM templates and editor; chart order / position / bracket lines with drag-to-modify; multiple paper accounts; order confirmations.
- Settings (P27 / P43): Chart, Footprint, Heatmap, DOM, Tape, Trading, Data, Alerts, Risk, Privacy, Logs, Custom modules and About sections; many existing settings wired into tables, journal, tape, DOM, toasts and the shell.
- UI kit v2 (P02): ColorPicker v2 and GradientEditor, Combobox, FontPicker, LineStylePicker, MenuSlider, Sheet, virtualized Table, TreeView, SplitPane; ribbon hide / reorder with Customize ribbon dialog.
- Remaining modules (P28): Web Pages, Logs (with in-app log buffer), Following Manager (local, sharing blocked), User Guide (F1), guided tour, sample replay session.

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
