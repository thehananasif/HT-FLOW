# Testing on Windows: "every button works"

No official release ships until every button is verified on Windows (see
[RELEASE.md → Release checklist](RELEASE.md#release-checklist)). Three layers do that:

| Layer                                 | What                                                                                         | Where it runs                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. Click-everything crawl (web build) | Playwright clicks every control of every surface                                             | Every CI run (`Checks & tests (Windows)` job, part of `pnpm e2e`)     |
| 2. Native app smoke test              | WebdriverIO drives the real `.exe` (Tauri + WebView2 + native commands) under `tauri-driver` | `windows-app-test.yml`, manual (`workflow_dispatch`) and on `v*` tags |
| 3. Manual checklist                   | A person ticks [MANUAL-TEST-CHECKLIST.md](MANUAL-TEST-CHECKLIST.md) on a real PC             | Before each release                                                   |

## 1. Click-everything crawl (Playwright, web build)

`apps/desktop/e2e/click-everything.spec.ts`, tagged `@clickall`.

```bash
pnpm e2e:clickall                                  # just the crawl
E2E_PORT=1431 pnpm e2e:clickall -g "modules: Info" # one slice
pnpm --filter @htflow/desktop exec playwright test --grep @clickall --shard=1/3   # split across machines
```

What it covers, enumerated from the registries (not a hand list) through
`window.__HTFLOW_INTROSPECT__` (`ui/src/platform/introspect.ts`):

- every ribbon module (module registry, one test per group chunk), the ribbon itself (▾ menus get
  their first entry picked), title bar, status bar, trading panel, side tools, chart window toolbar
  and every chart context-menu item;
- every Settings section (and the controls in it);
- every Command Palette command (command registry, 4 slices; families of identical handlers such as
  `inst.*` are sampled). Destructive commands (reset, delete, log out, lock, quit, flatten…) run
  last in a fresh browser context, re-creating the account when one ends the session;
- dialogs opened by any click: screenshot, tabs, _Apply_, then _Cancel_ / _Close_ / Escape;
- menus / listboxes opened by any click: the first item is picked; `<select>`s change option.

After every click it checks: no page error, no `console.error`, no unhandled promise rejection, no
CSP violation (allow-list with reasons: `e2e/clickall/policy.ts`); the app still responds (a hidden
heartbeat in the status bar keeps beating); nothing overflows its window horizontally and no
visible text overlaps (checked when a surface, tab or dialog opens); and that something observable
happened (DOM / dialog / window / toast change). "No visible effect" and "not clickable" are
**warnings** in the report, everything else fails the test.

Report: `apps/desktop/test-results/click-report/index.html` (+ `report.json`, screenshots of every
module and dialog under `shots/`). CI uploads it with the Playwright report on failure.

Shared, framework-agnostic pieces (used by layer 2 as well):

- `e2e/clickall/inpage.js` — in-page probe (error hooks, control enumeration, layout checks, state
  snapshot). Plain JS, no build step.
- `e2e/clickall/core.ts` — the crawler (`Driver` interface: `exec`, `click`, `press`, `screenshot`).
- `e2e/clickall/policy.ts` — destructive controls / commands, benign console messages.
- `e2e/clickall/report.ts` — JSON + HTML report.

## 2. Native app smoke test (real .exe, WebView2)

Workflow `.github/workflows/windows-app-test.yml` (Actions → _Windows app test (native)_ → _Run
workflow_; tick _quick_ for native paths only). It builds `tauri build --debug --no-bundle` (real
Tauri runtime, native commands and the embedded production frontend, faster than release),
installs `tauri-driver` (`cargo install tauri-driver --locked`) and a matching `msedgedriver` with
`msedgedriver-tool`, starts `tauri-driver --port 4444`, then runs `e2e/native/run.ts`
(WebdriverIO, no test runner). Artifact: `windows-app-test-report` (HTML/JSON report, screenshots,
tauri-driver logs).

Native paths checked: create account + PIN, lock / unlock with the PIN, open log folder, back up
now, open a Web Page window, detach a window to an OS window and re-attach, Binance and Bybit symbol
discovery, COT fetch, news and calendar fetch (each must answer — a region / network error state is
fine, a hang is not), AI provider validation without a key (default endpoint accepted, plain-http
custom endpoint refused), HT Editor backtest in the sandbox worker (no CSP / worker error), file
association (second launch with a `.htstrat` path on the command line opens it in the HT Editor),
heartbeat. Then the same crawl as layer 1 over every module and the Command Palette.

### Run it locally on Windows

```powershell
pnpm install
pnpm --filter @htflow/desktop tauri build --debug --no-bundle
cargo install tauri-driver --locked
cargo install --git https://github.com/chippers/msedgedriver-tool; msedgedriver-tool   # downloads msedgedriver.exe here
tauri-driver --port 4444 --native-driver .\msedgedriver.exe   # leave running
cd apps/desktop
pnpm e2e:native -- --app ..\..\target\debug\htflow-desktop.exe [--quick]
```

### Check the test logic without Windows (`--web`)

```bash
pnpm --filter @htflow/desktop dev --port 1420 &      # web build
cd apps/desktop && pnpm e2e:native:web [--quick]     # same runner, Chrome (Playwright's Chromium)
```

WebdriverIO starts a matching chromedriver itself. Native-only checks report the handled
"no Tauri IPC (web build)" state; the file-association check is skipped.

## 3. Manual checklist

[MANUAL-TEST-CHECKLIST.md](MANUAL-TEST-CHECKLIST.md) is generated from the registries:
`WRITE_CHECKLIST=1 pnpm e2e:clickall -g registry`. Regenerate it whenever a module or command is
added, print it and tick it on a real Windows PC with the installed release candidate.
