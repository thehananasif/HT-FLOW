# Performance

Benchmarks of the spec's performance targets (P29; HARD CONSTRAINTS 4, P04, P08, P10, P11, P15, P16, P46). Run them with:

```
pnpm bench
```

`pnpm bench` runs `apps/desktop/bench/*.perf.ts` with `vitest.bench.config.ts`: one file at a time in a single process, so the measurements do not compete with each other for CPU. At the end it rewrites the **Machine** and **Results** sections below (between the `bench:start` / `bench:end` markers) and keeps the rest of this file. Set `BENCH_NO_REPORT=1` to run without touching the file.

## What is measured

Every benchmark drives the app's real code: the chart windows are built with `buildChart` (the same templates and layers as the chart window), the heatmap is the liquidity-map template, the tape frame is the Smart Tape window's own `drawTape`, the DOM is `DomModel` + `DomLadder`, and the search is the Instrument Picker's `SearchIndex`.

The canvas modules run under jsdom with a **headless 2D context**: every canvas call is a no-op. The numbers are therefore the **CPU (JavaScript) cost of building a frame** — scales, auto-scale, aggregation, row merging, colour grading, number formatting and the stream of draw calls. They do not include raster / compositing time in the WebView (WebView2 rasterises Canvas2D on the GPU). The budget for a 60 fps frame is 16.7 ms and for 30 fps 33.3 ms; a frame whose CPU part takes more than about half the budget is at risk once raster time is added.

Data sets (deterministic, seeded):

| Target                 | Data                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Charts, 1M+ ticks      | 1,000,000 prints over 4 days on BTCUSDT (5,760 M1 bars / 1,152 M5 bars / 384 M15 bars)                                                         |
| 8 charts               | the same store; 4 footprint (M5) + 4 candles-and-profiles (M1) charts at 800×450, all redrawn in the same frame while panning / zooming        |
| 2,000 visible clusters | footprint, M15 bars, one tick per row, 2,560×1,600 window; the visible cell count is printed in the result                                     |
| Footprint mode switch  | `ChartHandle.update()` with a new mode + the first frame                                                                                       |
| Heatmap                | 2,000 one-pixel columns × 400 levels of synthetic CL-like depth (bubbles, best bid / ask and DOM column on), a new column appended every frame |
| Indicators             | 50,000 M1 bars with 8 prints over several price levels each; 10 indicators on 2 simulated workers (`SimTransport` structured-clones both ways) |
| Tape                   | Smart Tape at 5,000 and 20,000 prints/s: 1/60 s of prints ingested per frame + 45 visible rows drawn                                           |
| DOM                    | 320 updates per 16 ms frame (20 / ms), all columns on, 200k-print session                                                                      |
| Search                 | 10,000 generated symbols, 8 query shapes including typos                                                                                       |

## Targets that are not measured here

- **Cold start < 3 s** and **idle RAM < 400 MB** need the packaged Windows app (Tauri + WebView2); measure with the release build on Windows (Task Manager → Details, working set after 60 s idle with the default workspace; cold start from double-click to the first painted chart).
- **8-hour soak** on 6 live crypto streams needs network access to the exchanges (see `docs/BLOCKERS.md`).
- **GPU raster time**: profile in the running app with the WebView DevTools (Performance panel) and the chart debug overlay (Settings → Performance → Show debug info).

## Optimisations (P29)

- Footprint cells: `rgba()` parsed the hex colour on every call (two to five calls per cell per frame). The parse is now cached per colour, the delta / volume colour strings are built only by the style branch that uses them, and the two cell fonts are built once per frame instead of once per cell. Output strings are identical.
- Footprint rows: `mergeRows` ran for every visible bar on every frame. `RowCache` memoises the merged rows per bar and row size and rebuilds them when the bar's volume, trade count or price levels change, so closed bars are merged once and the live bar stays exact.
- Together: the 2,461-cell footprint frame went from about 7.0 ms to about 4.6 ms of CPU on the machine below.

## Indicator lag (round 7)

User report: "Whenever I apply an indicator the software starts to LAG." Profiled with `apps/desktop/bench/indicators.perf.ts` (50,000 M1 bars with footprint clusters, 10 indicators: SMA, EMA, RSI, MACD, Bollinger, VWAP, Cumulative Delta, Stacked Imbalance, Cluster Statistic, FVG, 2 workers) and a per-indicator sweep of every registered indicator.

Causes found (in order of impact):

1. **Bars structured-cloned per indicator.** `RemoteRuntime` posted `bars.slice(0)` — 50,000 `Bar` objects, each with a `Map` of clusters — to its worker on every apply / history reload. Cloning cost ~20 µs per bar on the main thread: about **1 s per indicator**, 10 indicators = a 4–5 s freeze.
2. **Full list outputs re-sent on every tick.** The worker replied with every marker / level / zone on each tick and the main thread rebuilt the lists: 15,000 FVG zones = 24 ms, Cluster Statistic's 200,000 grid cells = 450 ms of main-thread deserialisation **per tick**.
3. **Full-history work per tick in the worker.** The changed-range check copied every output column of the whole history (`slice(0, count)`) and compared it again on each tick: 2–30 ms per indicator per tick, unbounded queue when ticks came faster.
4. **No backpressure.** Every frame with a new data version posted another message even while the worker was still busy, so a burst built a queue of stale work and results trailed the market.
5. **O(n²) full recomputes.** ZigZag redrew its whole current leg on every bar (6.5 s for 50k bars on a trendless series); FVG and Order Blocks scanned every zone ever created on every bar (1.1 s / 0.5 s).
6. Minor: the paint order of outputs was sorted on every frame.

Fixes (outputs are bit-identical — see the golden tests below):

- **Columnar wire format** (`indicator-sdk/src/wire.ts`): bars are packed into three typed arrays (`packBars`, ~1 µs per bar; the clone is a memcpy), memoised per (bars, from, version) so the indicators of a chart pack once, and each worker receives the packet **once** (`packedRef` lets the next indicators on that worker reuse it). Long list tails go columnar too (`packList` / `unpackList`, same keys in the same order).
- **List diffs**: the worker keeps a shadow of what it sent and replies with `listFrom` + only the items from the first change; definitions that never edit old items can declare `listsAppendOnly` (Cluster Statistic) and skip the compare.
- **History diff only when needed**: new optional meta `stableHistory` (calc(i) writes bar i only) skips the history diff; built-ins get it automatically except ZigZag, Ichimoku and timeframe-input indicators, and a test proves every flagged built-in never rewrites a past bar. The diff itself is allocation-free (persistent shadows).
- **Backpressure**: one message in flight per runtime; updates while the worker is busy coalesce into one message sent when the reply arrives.
- **Algorithms**: ZigZag redraws a leg only when its pivot / extreme changes (and undoes the previous calc of the live bar), FVG / Order Blocks start scanning at the first zone that may still be open (`openFrom`): 6,482 → 28 ms, 1,123 → 24 ms, 528 → 27 ms on 50k bars.
- Already in place and kept: rendering walks only the visible bar range, main-thread runtimes update once per animation frame inside the draw, and poolable indicators always compute in workers (tape / feed indicators stay on the main thread, where their per-tick cost is microseconds).

| Measurement (50,000 bars, 10 indicators) | Before                                                          | After          |
| ---------------------------------------- | --------------------------------------------------------------- | -------------- |
| Apply — main thread (UI freeze)          | 4,491 ms                                                        | ~150–350 ms    |
| Apply — compute in the workers           | 937 ms                                                          | ~470–600 ms    |
| Live tick — main thread per tick         | 316 ms                                                          | ~1.6 ms        |
| Tick throughput (2 workers)              | 238 ticks/s in the workers, but main-thread bound at ~3 ticks/s | ~1,400 ticks/s |

What remains on the main thread when applying is mostly decoding Cluster Statistic's 200,000 grid cells into marker objects (~100 ms).

Golden tests: `packages/indicators/src/incremental.test.ts` runs every registered indicator through the live path (one update per print) and compares it with a full recompute, round-trips both codecs, runs several indicators on one shared worker packet against the main-thread result, and checks the `stableHistory` flag. `e2e/indicators-perf.spec.ts` samples `requestAnimationFrame` before and after adding six indicators to a live chart.

## Flaky timing tests (P29)

Timing assertions in `pnpm test` are smoke checks only, because every suite shares the CPU. `heatmap/pixelBuffer.test.ts` now asserts determinism and cell counts and uses the median of 7 frames against a loose ceiling; `market-data/barTypes.test.ts` gets a 60 s timeout on the hour-of-prints equivalence tests (they are functional checks that took > 5 s under load); `tape.test.ts` uses the median of 3 runs; `market-catalog/searchBench.test.ts` keeps its median-of-7 per query but guards at 250 ms (it failed once at load average 21). Strict budgets live only in `pnpm bench`, whose own assertions are also generous (6× the budget) so that a slow machine never fails CI — the report shows the real Pass / Miss.

<!-- bench:start -->

## WebGL2 vs Canvas2D backend (round 7)

`Footprint › Large footprint … Canvas2D / WebGL2 backend` draws the same 2,000+-cell frame with each backend (`chart.renderer`). Both build the same rect instances (`buildCandles`, `buildFootprintCell`, …); Canvas2D replays them as one `fillRect` per rect, WebGL2 uploads one `Float32Array` per bar and issues one instanced draw. On the machine below the WebGL2 path costs about 3.6 ms of CPU per frame against about 4.0 ms for Canvas2D (median; p95 6.2 vs 10.5 ms) — the remaining cost is row merging, colour grading and the cell text, which stays on the Canvas2D overlay. The GPU side is not in these numbers (headless contexts): with WebGL2 the browser no longer rasterises thousands of anti-aliased rects on the CPU / 2D path, which is where the real-app gain is; profile it with the WebView DevTools. Headless Chromium uses a software GL (SwiftShader), so `auto` keeps Canvas2D there and the e2e suite runs unchanged.

## Time to first candle (round 7)

Measured by `history::tests::first_paint_needs_three_requests` (`cargo test -p htflow-desktop --lib first_paint -- --nocapture`): a busy USDⓈ-M symbol (50 trades / s) opened with 30 minutes of history against a local mock of the Binance REST API.

| Path                                          | REST requests before the first candle | Time (Binance public rate: 10 burst + 2 / s) |
| --------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| Before: forward `aggTrades` paging            | 90 needed, capped at 60               | ≈ 25 s + 60 round trips                      |
| After: newest-first `recent_window` (3 pages) | 3                                     | 3 round trips (29 ms against the mock)       |

The rest of the history arrives in the background (`charts/history.ts` `runBackfill`), with a spinner on the chart and progress in the footer; the browser preview's simulated feeds are unchanged.

## Machine

- CPU: Intel(R) Xeon(R) Processor @ 2.30GHz (4 logical cores)
- RAM: 16 GB
- Load average at the end of the run: 9.56 / 8.69 / 4.74 (other work on the machine inflates p95)
- OS: linux 6.18.44-fc-v595
- Node.js v22.23.4, Vitest (jsdom for the canvas modules), headless 2D context
- Run: 2026-11-18 13:44 UTC

## Results

### Indicators

| Measurement                                                                                                                                                      | Spec target                                 | Budget         | Median       | p95         | Result |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------- | ------------ | ----------- | ------ |
| Apply 10 indicators to 50,000 bars — main thread (UI freeze) — sma, ema, rsi, macd, bollinger, vwap, cumulative-delta, stacked-imbalance, cluster-statistic, fvg | applying indicators keeps the UI responsive | ≤ 500 ms       | 201 ms       | 294 ms      | Pass   |
| Apply 10 indicators to 50,000 bars — compute in the workers (total)                                                                                              | indicators appear within a second           | ≤ 1000 ms      | 501 ms       | 956 ms      | Pass   |
| Live tick with 10 indicators (50,000 bars) — main thread per tick                                                                                                | 50 ticks/s with 10 indicators at 60 fps     | ≤ 2.00 ms      | 1.53 ms      | 6.00 ms     | Pass   |
| Tick throughput with 10 indicators (50,000 bars, 2 workers)                                                                                                      | 50 ticks/s with 10 indicators               | ≥ 50.0 ticks/s | 1535 ticks/s | 153 ticks/s | Pass   |

### Charts

| Measurement                                                     | Spec target                      | Budget    | Median  | p95     | Result |
| --------------------------------------------------------------- | -------------------------------- | --------- | ------- | ------- | ------ |
| Candles + profiles, 1,000,000 ticks (5760 M1 bars), pan / zoom  | 60 fps pan / zoom with 1M+ ticks | ≤ 16.7 ms | 0.72 ms | 3.84 ms | Pass   |
| Candles zoomed out, ~1500 bars visible                          | 60 fps pan / zoom with 1M+ ticks | ≤ 16.7 ms | 2.22 ms | 5.61 ms | Pass   |
| Footprint bid x ask, 1,000,000 ticks (1152 M5 bars), pan / zoom | 60 fps pan / zoom with 1M+ ticks | ≤ 16.7 ms | 0.60 ms | 3.80 ms | Pass   |
| 8 charts, every chart redrawn in the same frame                 | open 8 charts at once at 60 fps  | ≤ 16.7 ms | 3.24 ms | 8.78 ms | Pass   |

### Footprint

| Measurement                                                    | Spec target                      | Budget    | Median  | p95     | Result |
| -------------------------------------------------------------- | -------------------------------- | --------- | ------- | ------- | ------ |
| 2,461 visible cells (63 M15 bars, 1 tick per row) at 2560×1600 | 2,000 visible clusters at 60 fps | ≤ 16.7 ms | 3.57 ms | 8.13 ms | Pass   |
| Switch footprint mode (update + first frame)                   | switching footprint mode < 50 ms | ≤ 50.0 ms | 0.52 ms | 0.80 ms | Pass   |

### Heatmap

| Measurement                                                                             | Spec target                            | Budget    | Median  | p95     | Result |
| --------------------------------------------------------------------------------------- | -------------------------------------- | --------- | ------- | ------- | ------ |
| Pixel buffer only, 2000 × 400 (588,787 cells)                                           | 30 fps with 400 levels × 2,000 columns | ≤ 33.3 ms | 7.84 ms | 12.7 ms | Pass   |
| Liquidity map, 2005 × 491 visible (bubbles, best bid / ask, DOM column on), live append | 30 fps with 400 levels × 2,000 columns | ≤ 33.3 ms | 15.2 ms | 23.7 ms | Pass   |

### Time & Sales

| Measurement                                                            | Spec target                          | Budget          | Median              | p95                | Result |
| ---------------------------------------------------------------------- | ------------------------------------ | --------------- | ------------------- | ------------------ | ------ |
| Smart Tape at 5,000 prints/s (84 prints + 45 visible rows per frame)   | 5,000 prints/s stays smooth (60 fps) | ≤ 16.7 ms       | 2.35 ms             | 3.69 ms            | Pass   |
| Smart Tape at 20,000 prints/s (334 prints + 45 visible rows per frame) | 5,000 prints/s stays smooth (60 fps) | ≤ 16.7 ms       | 1.97 ms             | 3.30 ms            | Pass   |
| Tape buffer ingest (aggregation by timestamp, 600k prints)             | 5,000 prints/s                       | ≥ 5000 prints/s | 26,294,963 prints/s | 8,977,851 prints/s | Pass   |

### Search

| Measurement                                                        | Spec target                   | Budget    | Median  | p95     | Result |
| ------------------------------------------------------------------ | ----------------------------- | --------- | ------- | ------- | ------ |
| Instrument search over 10,000 symbols (8 query shapes incl. typos) | 10,000+ symbol search < 50 ms | ≤ 50.0 ms | 1.99 ms | 4.26 ms | Pass   |

### Smart DOM

| Measurement                                                                       | Spec target                                | Budget    | Median  | p95     | Result |
| --------------------------------------------------------------------------------- | ------------------------------------------ | --------- | ------- | ------- | ------ |
| Burst of 320 updates (20 / ms) → model update → full ladder draw, every column on | DOM update latency < 16 ms socket to pixel | ≤ 16.0 ms | 0.33 ms | 0.81 ms | Pass   |

### Aggregation

| Measurement                                                                 | Spec target                                       | Budget   | Median  | p95     | Result |
| --------------------------------------------------------------------------- | ------------------------------------------------- | -------- | ------- | ------- | ------ |
| 1M ticks → M1 cluster bars (columnar path, used when a chart loads history) | charts open with 1M+ ticks (P07: 10M ticks < 1 s) | ≤ 100 ms | 57.5 ms | 66.4 ms | Pass   |

<!-- bench:end -->
