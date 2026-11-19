/**
 * Native Windows smoke test: drives the real HT Flow .exe (Tauri + WebView2) under tauri-driver
 * with WebdriverIO, using the same crawler as the Playwright click-everything spec
 * (e2e/clickall/core.ts). See docs/TESTING-WINDOWS.md.
 *
 *   node --import ./e2e/native/register.mjs e2e/native/run.ts --app <path-to-htflow-desktop.exe>
 *   node --import ./e2e/native/register.mjs e2e/native/run.ts --web [--url http://localhost:1420]
 *
 * `--web` runs the same logic against the web build in Chrome (Playwright's Chromium) so the test
 * logic can be checked on Linux / without a Windows machine. Native-only checks then report the
 * "no Tauri IPC" error state, which counts as handled.
 *
 * Exit code 1 when any check or crawled control fails. Report: test-results/native-report/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';
import {
  crawlSurface,
  heartbeatAlive,
  runCommands,
  takeErrors,
  type Driver,
  type StepResult,
} from '../clickall/core';
import { isDestructiveCommand } from '../clickall/policy';
import { buildReport, renderHtml, type ReportPart } from '../clickall/report';
import {
  check,
  clickEl,
  createAccountFlow,
  fill,
  invokeNative,
  PIN,
  waitFor,
} from '../clickall/flows';

const here = dirname(fileURLToPath(import.meta.url));
const INPAGE = readFileSync(join(here, '..', 'clickall', 'inpage.js'), 'utf8');
const OUT = resolve(here, '..', '..', 'test-results', 'native-report');

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WEB = argv.includes('--web');
const APP = arg('--app');
const URL_ = arg('--url') ?? `http://localhost:${process.env.E2E_PORT ?? 1420}`;
const DRIVER_PORT = Number(arg('--port') ?? 4444);
/** Skip the full module crawl (native paths only) — handy for a quick local check. */
const QUICK = argv.includes('--quick');

type Browser = Awaited<ReturnType<typeof remote>>;

async function session(extraArgs: string[] = []): Promise<Browser> {
  if (WEB) {
    const { chromium } = await import('@playwright/test');
    return remote({
      logLevel: 'warn',
      capabilities: {
        browserName: 'chrome',
        'wdio:enforceWebDriverClassic': true,
        'goog:chromeOptions': {
          binary: chromium.executablePath(),
          args: ['--headless=new', '--window-size=1600,900', '--no-sandbox'],
        },
      },
    });
  }
  if (!APP) throw new Error('--app <path to htflow-desktop.exe> is required (or --web)');
  return remote({
    hostname: '127.0.0.1',
    port: DRIVER_PORT,
    logLevel: 'warn',
    capabilities: {
      // tauri-driver translates this into an msedgedriver (WebView2) session.
      browserName: 'wry',
      'wdio:enforceWebDriverClassic': true,
      'tauri:options': { application: resolve(APP), args: extraArgs },
    } as WebdriverIO.Capabilities,
  });
}

function driverFor(b: Browser): Driver {
  mkdirSync(join(OUT, 'shots'), { recursive: true });
  let main: string | undefined;
  const run = <T>(expression: string) =>
    b.execute(`return (${expression});`) as unknown as Promise<T>;
  return {
    async exec<T>(expression: string) {
      main ??= await b.getWindowHandle();
      try {
        return await run<T>(expression);
      } catch {
        // A control opened another window / tab or reloaded the page: go back to the main window,
        // re-install the probe and retry once.
        const handles = await b.getWindowHandles();
        if (handles.includes(main)) await b.switchToWindow(main);
        else if (handles[0]) await b.switchToWindow((main = handles[0]));
        await waitForReady(b);
        await b.execute(`(() => { ${INPAGE}; return true; })()`);
        return run<T>(expression);
      }
    },
    async click(selector, opts) {
      const el = await b.$(selector);
      await el.scrollIntoView({ block: 'center' }).catch(() => undefined);
      if (opts?.button === 'right') await el.click({ button: 'right' });
      else await el.click();
    },
    async contextClick(x, y) {
      await b
        .action('pointer')
        .move({ x: Math.round(x), y: Math.round(y) })
        .down({ button: 2 })
        .up({ button: 2 })
        .perform();
    },
    press: (key) => b.keys(key === 'Escape' ? ['Escape'] : [key]),
    async screenshot(name, selector) {
      const rel = `shots/${name}.png`;
      try {
        if (selector) await (await b.$(selector)).saveScreenshot(join(OUT, rel));
        else await b.saveScreenshot(join(OUT, rel));
        return rel;
      } catch {
        return undefined;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function waitForReady(b: Browser) {
  for (let i = 0; i < 50; i++) {
    const ok = await b.execute('return document.readyState').catch(() => '');
    if (ok === 'complete') return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function install(d: Driver) {
  await d.exec(`(() => { ${INPAGE}; return true; })()`);
}

async function boot(b: Browser, user: string): Promise<Driver> {
  if (WEB) await b.url(URL_);
  const d = driverFor(b);
  await waitFor(d, `document.readyState === 'complete'`, 60_000);
  await install(d);
  await createAccountFlow(d, user);
  await d.sleep(500);
  return d;
}

const intro = (d: Driver, expr: string) => d.exec(`window.__HTFLOW_INTROSPECT__.${expr}`);

async function nativePaths(d: Driver, b: Browser): Promise<StepResult[]> {
  const out: StepResult[] = [];
  await check(d, 'Create account with PIN', out, async () => 'dashboard shown');
  await check(d, 'Lock, then unlock with PIN', out, async () => {
    await intro(d, `runCommand('lock')`);
    if (
      !(await waitFor(
        d,
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Unlock with PIN')`,
      ))
    )
      throw new Error('lock screen did not appear');
    await install(d);
    await clickEl(d, 'button', 'Unlock with PIN');
    await waitFor(d, `document.querySelector('[role="dialog"] input')`);
    const inputs = '[role="dialog"] input';
    await fill(d, inputs, 0, 'nativeuser');
    await fill(d, inputs, 1, PIN);
    await clickEl(d, '[role="dialog"] button', 'Unlock');
    if (!(await waitFor(d, `document.querySelector('[data-testid="trading-panel"]')`, 30_000)))
      throw new Error('dashboard did not come back after the PIN unlock');
    return 'unlocked';
  });
  await check(d, 'Open log folder', out, async () => {
    const r = await invokeNative(d, 'open_log_folder');
    if (!WEB && r.startsWith('error')) throw new Error(r);
    return r;
  });
  await check(d, 'Back up now', out, async () => {
    const r = await invokeNative(d, 'profile_backup_now');
    if (!WEB && r.startsWith('error')) throw new Error(r);
    return r;
  });
  await check(d, 'Open a Web Page window', out, async () => {
    const n = (await intro(d, 'windowCount()')) as number;
    await intro(d, `runCommand('open.web-pages')`);
    await d.sleep(800);
    const m = (await intro(d, 'windowCount()')) as number;
    if (m <= n) throw new Error('no window opened');
    return `windows ${n}→${m}`;
  });
  await check(d, 'Detach the active window to an OS window, then re-attach', out, async () => {
    // Ask the app which secondary windows exist: msedgedriver does not list a new WebView2
    // window as a WebDriver handle, so getWindowHandles() cannot see it.
    const count = async () => {
      if (WEB) return (await b.getWindowHandles()).length;
      const r = await invokeNative(d, 'os_window_list');
      if (!r.startsWith('ok: ')) throw new Error(`os_window_list: ${r}`);
      return (r.match(/"label"/g) ?? []).length;
    };
    const n0 = await count();
    await intro(d, `runCommand('detach-os')`);
    let n1 = n0;
    for (let i = 0; i < 20 && n1 <= n0; i++) {
      await d.sleep(500);
      n1 = await count();
    }
    await intro(d, `runCommand('window.reattach-all')`);
    let n2 = n1;
    for (let i = 0; i < 20 && n2 > n0; i++) {
      await d.sleep(500);
      n2 = await count();
    }
    if (!WEB && n1 <= n0) {
      const reg = JSON.stringify(await intro(d, 'osWindows()'));
      const probs = ((await intro(d, 'recentProblems(5)')) as string[]).join(' | ');
      throw new Error(`no OS window appeared (registry ${reg}; log: ${probs || 'none'})`);
    }
    if (n2 > n0) throw new Error('OS window did not close on re-attach');
    return `OS windows ${n0}→${n1}→${n2}`;
  });
  await check(d, 'Binance symbol discovery', out, () =>
    invokeNative(d, 'instruments_list', { venue: 'binance', refresh: true }, 90_000),
  );
  await check(d, 'Bybit symbol discovery', out, () =>
    invokeNative(d, 'instruments_list', { venue: 'bybit', refresh: true }, 90_000),
  );
  await check(d, 'COT fetch', out, () =>
    invokeNative(
      d,
      'cot_fetch',
      {
        report: 'legacy',
        marketCode: '088691',
        fromDate: '2025-01-01',
        force: false,
        cacheOnly: false,
      },
      90_000,
    ),
  );
  await check(d, 'News fetch', out, () =>
    invokeNative(d, 'feed_fetch', {
      url: 'https://www.federalreserve.gov/feeds/press_all.xml',
      force: true,
    }),
  );
  await check(d, 'Economic calendar fetch', out, () =>
    invokeNative(d, 'calendar_fetch', { force: true }),
  );
  await check(d, 'AI provider validation (no key)', out, async () => {
    const a = await invokeNative(d, 'ai_check_url', { provider: 'anthropic', baseUrl: null });
    const b2 = await invokeNative(d, 'ai_check_url', {
      provider: 'custom',
      baseUrl: 'http://example.com',
    });
    const k = await invokeNative(d, 'ai_key_status', { configId: 'anthropic' });
    if (!WEB && !a.startsWith('ok')) throw new Error(`default endpoint rejected: ${a}`);
    if (!WEB && !b2.startsWith('error'))
      throw new Error(`plain-http custom endpoint accepted: ${b2}`);
    return `${a} · ${b2} · key ${k}`;
  });
  await check(d, 'HT Editor backtest in the sandbox worker (CSP)', out, async () => {
    await intro(d, `runCommand('strategies.editor')`);
    if (!(await waitFor(d, `document.querySelector('[data-testid="hte-backtest"]')`, 20_000)))
      throw new Error('HT Editor did not open');
    await clickEl(d, '[data-testid="hte-backtest"]');
    await d.sleep(6000);
    const errs = await takeErrors(d);
    if (errs.length) throw new Error(errs.join(' | '));
    return 'backtest ran without CSP / worker errors';
  });
  await check(d, 'App still responsive', out, async () => {
    if (!(await heartbeatAlive(d, 3000))) throw new Error('heartbeat frozen');
    return 'heartbeat ok';
  });
  return out;
}

/**
 * File association (.htstrat double-click). tauri-driver forwards `tauri:options.args` to WebView2
 * as browser switches ("Ignoring switch with invalid name"), not to the app's own argv, so a second
 * launch with a file path cannot be driven here. The command-line → HT Editor route is covered by
 * the unit tests (openFile / openfile.rs) and the manual checklist (docs/MANUAL-TEST-CHECKLIST.md).
 */
async function fileAssociation(): Promise<StepResult[]> {
  return [
    {
      surface: 'Native paths',
      control: 'File association (.htstrat via command line)',
      role: 'check',
      status: 'skip',
      effect: '',
      notes: [
        WEB
          ? 'native only'
          : 'not drivable under tauri-driver (args go to WebView2); manual checklist item',
      ],
    },
  ];
}

async function crawl(d: Driver): Promise<ReportPart> {
  const part: ReportPart = {
    name: 'native-crawl',
    runner: WEB ? 'wdio-web' : 'wdio-native',
    surfaces: [],
  };
  const reset = async () => {
    await intro(d, `runCommand('layout.single')`);
    await d.press('Escape');
    await d.sleep(300);
  };
  part.surfaces.push(await crawlSurface(d, 'Title bar', 'Shell', '.titlebar'));
  part.surfaces.push(await crawlSurface(d, 'Status bar', 'Shell', '.statusbar'));
  await reset();
  part.surfaces.push(await crawlSurface(d, 'Side tools', 'Chart', '[data-testid="sidetools"]'));
  const mods = (await intro(d, 'modules()')) as { id: string; label: string; group: string }[];
  for (const m of mods) {
    await reset();
    await takeErrors(d);
    const open = async () => {
      await intro(d, `runCommand(${JSON.stringify(`open.${m.id}`)})`);
      await d.sleep(500);
    };
    await open();
    part.surfaces.push(
      await crawlSurface(d, `${m.label} (${m.id})`, m.group, 'active-panel', {
        maxControls: 40,
        budgetMs: 60_000,
        reopen: async () => {
          await reset();
          await open();
        },
      }),
    );
  }
  await reset();
  const cmds = ((await intro(d, 'commands()')) as { id: string; label: string }[]).filter(
    (c) => !isDestructiveCommand(c.id, c.label) && !/^(inst|chart|tf|dom\.open)\./.test(c.id),
  );
  const steps: StepResult[] = [];
  for (let i = 0; i < cmds.length; i += 12) {
    await reset();
    steps.push(...(await runCommands(d, cmds.slice(i, i + 12))));
  }
  part.commands = steps;
  return part;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const parts: ReportPart[] = [];
  const b = await session();
  try {
    const d = await boot(b, 'nativeuser');
    const native = await nativePaths(d, b);
    parts.push({
      name: 'native-paths',
      runner: WEB ? 'wdio-web' : 'wdio-native',
      surfaces: [],
      commands: native,
    });
    if (!QUICK) parts.push(await crawl(d));
  } finally {
    await b.deleteSession().catch(() => undefined);
  }
  parts.push({
    name: 'native-file-association',
    runner: 'wdio-native',
    surfaces: [],
    commands: await fileAssociation(),
  });
  const report = buildReport(
    parts,
    WEB ? 'WebdriverIO · web build (--web)' : 'WebdriverIO · tauri-driver · WebView2',
  );
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'index.html'), renderHtml(report));
  console.log(
    `native report: ${report.totals.controls} steps, ${report.totals.fail} failures, ${report.totals.warn} warnings → ${OUT}/index.html`,
  );
  for (const part of parts)
    for (const c of part.commands ?? [])
      if (part.name !== 'native-crawl')
        console.log(`  ${c.status.toUpperCase().padEnd(4)} ${c.control}: ${c.notes.join(' | ')}`);
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  process.exit(report.failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
