/**
 * Regenerates the User Guide screenshots (docs/user-guide/images/*.webp) and the generated
 * shortcut table inside docs/user-guide/16-keyboard-shortcuts.md.
 *
 *   pnpm guide:screenshots                 # everything
 *   GUIDE_ONLY=charts pnpm guide:screenshots   # only sections whose name contains "charts"
 *
 * It drives the web build with the built-in mock feed (deterministic seed), so the images are
 * reproducible. Screenshots are taken at deviceScaleFactor 2, converted to WebP in the browser
 * (no extra dependencies) and annotated through a temporary CSS overlay (numbered boxes).
 * Failed shots are reported at the end; the others are still written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '../../../docs/user-guide');
const IMAGES = resolve(DOCS, 'images');
const ONLY = process.env.GUIDE_ONLY ?? '';
const QUALITY = 0.78;

interface Mark {
  loc: Locator;
  label?: string;
}
interface ShotOpts {
  /** Capture only this element (default: the whole window). */
  target?: Locator;
  marks?: Mark[];
}

const failures: string[] = [];
let converter: Page;

async function toWebp(png: Buffer): Promise<Buffer> {
  const b64 = await converter.evaluate(
    async ([data, q]) => {
      const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      const out = await c.convertToBlob({ type: 'image/webp', quality: q as number });
      const buf = new Uint8Array(await out.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [png.toString('base64'), QUALITY] as const,
  );
  return Buffer.from(b64, 'base64');
}

/** Numbered highlight boxes drawn over the page; removed again by the returned function. */
async function overlay(page: Page, marks: Mark[]): Promise<() => Promise<void>> {
  const boxes: { x: number; y: number; w: number; h: number; label: string }[] = [];
  let n = 0;
  for (const m of marks) {
    const b = await m.loc
      .first()
      .boundingBox()
      .catch(() => null);
    if (!b) continue;
    n++;
    boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height, label: m.label ?? String(n) });
  }
  await page.evaluate((bs) => {
    const root = document.createElement('div');
    root.id = 'guide-overlay';
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    for (const b of bs) {
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px;border:2px solid #ff4d4f;border-radius:5px;box-shadow:0 0 0 1px rgba(0,0,0,.6)`;
      const tag = document.createElement('div');
      tag.textContent = b.label;
      const top = b.y > 26;
      tag.style.cssText = `position:absolute;left:-2px;${top ? 'top:-24px' : 'bottom:-24px'};min-width:20px;padding:1px 6px;border-radius:10px;background:#ff4d4f;color:#fff;font:700 12px/18px system-ui,sans-serif;text-align:center;white-space:nowrap`;
      box.appendChild(tag);
      root.appendChild(box);
    }
    document.body.appendChild(root);
  }, boxes);
  return async () => {
    await page.evaluate(() => document.getElementById('guide-overlay')?.remove());
  };
}

async function shot(page: Page, name: string, opts: ShotOpts = {}): Promise<void> {
  try {
    await page.waitForTimeout(350);
    const clear = opts.marks?.length ? await overlay(page, opts.marks) : async () => {};
    const png = opts.target
      ? await opts.target.first().screenshot({ animations: 'disabled' })
      : await page.screenshot({ animations: 'disabled' });
    await clear();
    mkdirSync(IMAGES, { recursive: true });
    writeFileSync(resolve(IMAGES, `${name}.webp`), await toWebp(png));
  } catch (e) {
    failures.push(`${name}: ${String(e).split('\n')[0]}`);
  }
}

/** Runs one named part of the tour; a failing part is recorded and the next one still runs. */
async function part(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    await fn();
  } catch (e) {
    failures.push(`[${name}] ${String(e).split('\n')[0]}`);
    await converter.waitForTimeout(0);
  }
}

async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page
    .getByPlaceholder(/search commands/i)
    .first()
    .fill(query);
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

/** The dock group of the active window (header + content). */
function activeWindow(page: Page): Locator {
  return page.locator('.dv-groupview').filter({ has: page.locator('.dv-active-tab, .win-hdr') });
}

async function closeFloating(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const close = page.getByRole('dialog').getByRole('button', { name: /^(Close|Cancel)$/ });
    if (!(await close.count())) break;
    await close
      .first()
      .click()
      .catch(() => undefined);
  }
  await page.keyboard.press('Escape');
}

/** Back to a known layout: one chart + DOM + panel. */
async function reset(page: Page): Promise<void> {
  await closeFloating(page);
  await page.getByTitle('DOM | Chart | Panel').click();
  await page.waitForTimeout(600);
}

test('guide screenshots', async ({ page, context }) => {
  converter = await context.newPage();
  await converter.goto('about:blank');

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForTimeout(800);

  // ------------------------------------------------------------------ getting started
  await part('getting-started', async () => {
    await shot(page, 'login', {
      marks: [
        { loc: page.getByRole('button', { name: 'Create account' }).first(), label: '1' },
        { loc: page.getByRole('button', { name: /Unlock with PIN/ }), label: '2' },
        { loc: page.getByRole('button', { name: /Import profile/ }), label: '3' },
      ],
    });
    await page.getByRole('button', { name: 'Create account' }).first().click();
    const inputs = page.locator('form.create-form input');
    await inputs.nth(0).fill('Alex Trader');
    await inputs.nth(1).fill('alex');
    await inputs.nth(3).fill('Str0ng!Passw0rd');
    await inputs.nth(4).fill('Str0ng!Passw0rd');
    await shot(page, 'create-account', {
      marks: [
        { loc: inputs.nth(3), label: '1' },
        { loc: page.getByLabel('Timezone'), label: '2' },
        { loc: page.getByPlaceholder('••••••'), label: '3' },
      ],
    });
    await page.getByRole('button', { name: 'Create account' }).last().click();
    await page.getByTestId('recovery-code').waitFor();
    await shot(page, 'recovery-code', { marks: [{ loc: page.getByTestId('recovery-code') }] });
    await page.getByText('I have saved my recovery code').click();
    await page.getByRole('button', { name: 'Continue' }).click();
  });
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(2500);

  await part('getting-started-dashboard', async () => {
    await shot(page, 'dashboard', {
      marks: [
        { loc: page.locator('.titlebar'), label: '1' },
        { loc: page.locator('.ribbon').first(), label: '2' },
        { loc: page.getByTestId('trading-panel'), label: '3' },
        { loc: page.locator('.statusbar'), label: '4' },
      ],
    });
    await page.getByTestId('account-menu').click();
    await shot(page, 'account-menu');
    await page.keyboard.press('Escape');
    await page.getByTestId('account-menu').click();
    await page.getByRole('menuitem', { name: 'Change PIN…' }).click();
    await shot(page, 'pin-dialog', { target: page.getByRole('dialog') });
    await page.keyboard.press('Escape');
  });

  // ------------------------------------------------------------------ interface
  await part('interface', async () => {
    await shot(page, 'ribbon', { target: page.locator('.ribbon').first() });
    await shot(page, 'title-bar', { target: page.locator('.titlebar') });
    await shot(page, 'status-bar', { target: page.locator('.statusbar') });
    await page.getByTestId('help-menu').click();
    await shot(page, 'help-menu');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/search commands/i).fill('footprint');
    await shot(page, 'command-palette', { marks: [{ loc: page.getByPlaceholder(/search commands/i) }] });
    await page.keyboard.press('Escape');
    await page.getByTitle('Grid 2×2').click();
    await page.waitForTimeout(800);
    await shot(page, 'layout-grid');
    await page.getByTitle('1 + 2').click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Detach window' }).click();
    await page.waitForTimeout(500);
    await shot(page, 'floating-window');
    await reset(page);
    await page.getByTestId('ribbon-workspaces').click();
    await page.getByRole('menuitem', { name: 'Workspaces manager…' }).click();
    await shot(page, 'workspaces-manager');
    await reset(page);
    await page.getByTestId('workspace-menu').click();
    await shot(page, 'workspace-menu');
    await page.keyboard.press('Escape');
    await page.locator('.dv-tab').first().click({ button: 'right' }).catch(() => undefined);
    await page.keyboard.press('Escape');
    await palette(page, 'Customize ribbon');
    await shot(page, 'ribbon-customize');
    await closeFloating(page);
    await palette(page, 'Link groups manager');
    await shot(page, 'link-groups');
    await closeFloating(page);
  });

  await part('interface-themes', async () => {
    await page.keyboard.press('Control+,');
    await page.getByTestId('settings-window').waitFor();
    await palette(page, 'Settings: Appearance');
    await shot(page, 'settings-appearance');
    await reset(page);
  });

  // ------------------------------------------------------------------ data
  await part('data', async () => {
    await palette(page, 'Open Connections');
    await shot(page, 'connections');
    await page.getByRole('button', { name: /add|new|connect/i }).first().click().catch(() => undefined);
    await shot(page, 'connections-wizard');
    await closeFloating(page);
    await reset(page);
    await palette(page, 'Open Data manager');
    await shot(page, 'data-manager');
    await reset(page);
    await palette(page, 'Import CSV');
    await shot(page, 'import-csv');
    await closeFloating(page);
    await reset(page);
    await page.getByTestId('chart-footprint').click();
    await page.getByRole('button', { name: /TF/ }).first().click().catch(() => undefined);
    await shot(page, 'timeframes');
    await closeFloating(page);
    await page.keyboard.press('Escape');
    await page.getByTestId('chart-footprint').click();
    await page.keyboard.press('Control+g');
    await shot(page, 'go-to-date');
    await page.keyboard.press('Escape');
  });

  // ------------------------------------------------------------------ charts
  await part('charts', async () => {
    await reset(page);
    await page.getByTitle('Single').click();
    await page.waitForTimeout(800);
    const templates: [string, string][] = [
      ['New chart: Japanese Candlesticks with Volume Profile', 'chart-candles'],
      ['New chart: Footprint chart', 'chart-footprint'],
      ['New chart: Liquidity Map', 'chart-liquidity'],
      ['New chart: Order Flow (Dark)', 'chart-orderflow'],
      ['New chart: TPO Chart', 'chart-tpo'],
      ['New chart: Imbalance Chart', 'chart-imbalance'],
      ['New chart: Multi-timeframe Chart', 'chart-mtf'],
      ['New chart: Delta Profile', 'chart-delta-profile'],
      ['New chart: Volume Histogram', 'chart-volume-histogram'],
    ];
    for (const [cmd, img] of templates) {
      await palette(page, cmd);
      await page.waitForTimeout(1500);
      await shot(page, img, { target: activeWindow(page) });
    }
    await page.getByTitle('Single').click();
    await page.waitForTimeout(800);
    await page.getByTestId('template-menu').first().click();
    await shot(page, 'template-menu');
    await page.keyboard.press('Escape');
    await page.getByTestId('indicators-button').first().click();
    await shot(page, 'indicators-dialog');
    await page.keyboard.press('Escape');
    await closeFloating(page);
    await palette(page, 'RSI');
    await palette(page, 'Moving Average');
    await page.waitForTimeout(800);
    await shot(page, 'indicator-on-chart', { marks: [{ loc: page.getByTestId('indicator-legend') }] });
    await page.keyboard.press('Control+s');
    await shot(page, 'chart-settings');
    await closeFloating(page);
    const chart = page.getByTestId('chart-footprint').first();
    await chart.click({ button: 'right', position: { x: 300, y: 250 } }).catch(() => undefined);
    await shot(page, 'chart-context-menu');
    await page.keyboard.press('Escape');
  });

  await part('charts-drawing', async () => {
    const chart = page.locator('canvas').first();
    await palette(page, 'Draw: Trend Line');
    const box = (await page.getByTestId('chart-footprint').first().boundingBox())!;
    await page.mouse.move(box.x + 200, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await palette(page, 'Draw: Rectangle');
    await page.mouse.move(box.x + 450, box.y + 330);
    await page.mouse.down();
    await page.mouse.move(box.x + 560, box.y + 400, { steps: 8 });
    await page.mouse.up();
    await shot(page, 'drawings', { marks: [{ loc: page.locator('.side-tools, [data-testid="side-tools"]') }] });
    void chart;
    await palette(page, 'Open Objects List');
    await shot(page, 'objects-list');
    await reset(page);
  });

  // ------------------------------------------------------------------ order flow
  await part('order-flow', async () => {
    await reset(page);
    await page.getByTestId('chart-footprint').click();
    await page.keyboard.press('Alt+d');
    await shot(page, 'footprint-delta', { target: activeWindow(page) });
    await palette(page, 'Footprint: Quick settings');
    await shot(page, 'footprint-quick-settings');
    await closeFloating(page);
    await palette(page, 'Open Heatmap');
    await shot(page, 'heatmap-window');
    await palette(page, 'Heatmap: quick settings');
    await shot(page, 'heatmap-quick-settings');
    await page.keyboard.press('Escape');
    await reset(page);
    await shot(page, 'smart-dom', { target: page.getByTestId('win-hdr-dom-1').locator('xpath=ancestor::*[contains(@class,"dv-groupview")]') });
    await palette(page, 'Open Smart Tape');
    await shot(page, 'smart-tape');
    await palette(page, 'Open Bid/Ask Tape');
    await shot(page, 'bidask-tape');
    await palette(page, 'Open All Prices');
    await shot(page, 'all-prices');
    await reset(page);
  });

  // ------------------------------------------------------------------ trading
  await part('trading', async () => {
    await reset(page);
    await shot(page, 'trading-panel', { target: page.getByTestId('trading-panel') });
    await page.getByRole('button', { name: 'BUY MARKET' }).click();
    await page.waitForTimeout(800);
    await shot(page, 'position-open', {
      marks: [{ loc: page.getByTestId('trading-panel') }],
    });
    await palette(page, 'ATM templates');
    await shot(page, 'atm-setup');
    await closeFloating(page);
    await palette(page, 'Open Positions');
    await shot(page, 'positions-table');
    await palette(page, 'Open Orders');
    await palette(page, 'Open Accounts');
    await shot(page, 'accounts-table');
    await palette(page, 'Open Risk');
    await shot(page, 'risk-window');
    await palette(page, 'Open Journal');
    await shot(page, 'journal');
    await palette(page, 'Settings: Hot keys');
    await shot(page, 'settings-hotkeys');
    await reset(page);
    await palette(page, 'Paper accounts');
    await shot(page, 'paper-accounts');
    await closeFloating(page);
    await palette(page, 'Order confirmations');
    await shot(page, 'order-confirmations');
    await closeFloating(page);
    await page.getByRole('button', { name: 'Flatten all' }).first().click().catch(() => undefined);
  });

  // ------------------------------------------------------------------ replay
  await part('replay', async () => {
    await reset(page);
    await palette(page, 'Load sample replay session');
    await page.waitForTimeout(2500);
    await shot(page, 'replay-sample');
    await reset(page);
    await palette(page, 'Open Replay');
    await shot(page, 'replay-window');
    await reset(page);
  });

  // ------------------------------------------------------------------ alerts
  await part('alerts', async () => {
    await palette(page, 'Open Alerts');
    await shot(page, 'alerts-window');
    await page.getByTestId('alert-create').click().catch(() => undefined);
    await shot(page, 'alert-form');
    await closeFloating(page);
    await palette(page, 'Settings: Alerts');
    await shot(page, 'settings-alerts');
    await reset(page);
  });

  // ------------------------------------------------------------------ news
  await part('news', async () => {
    for (const [cmd, img] of [
      ['Open RSS Reader', 'rss'],
      ['Open News', 'news'],
      ['Open Calendar', 'calendar'],
      ['Open Web Pages', 'web-pages'],
    ] as const) {
      await palette(page, cmd);
      await page.waitForTimeout(600);
      await shot(page, img);
      await reset(page);
    }
  });

  // ------------------------------------------------------------------ scanners
  await part('scanners', async () => {
    for (const [cmd, img] of [
      ['Open Watchlist', 'watchlist'],
      ['Open Market Pressure', 'market-pressure'],
      ['Open Price Change', 'price-change'],
      ['Open DOM Pressure', 'dom-pressure'],
      ['Open Delta Divergence', 'delta-divergence'],
      ['Open Options Board', 'options-board'],
      ['Open Forward curve', 'forward-curve'],
    ] as const) {
      await palette(page, cmd);
      await page.waitForTimeout(900);
      await shot(page, img);
      await reset(page);
    }
  });

  // ------------------------------------------------------------------ strategies
  await part('strategies', async () => {
    await palette(page, 'Open Strategies');
    await shot(page, 'strategies-window');
    await page.getByTestId('strategy-run').click().catch(() => undefined);
    await page.waitForTimeout(6000);
    await shot(page, 'strategy-results');
    await reset(page);
  });

  // ------------------------------------------------------------------ settings / logs
  await part('settings', async () => {
    await palette(page, 'Settings: General');
    await shot(page, 'settings-general');
    await palette(page, 'Settings: Data');
    await shot(page, 'settings-data');
    await palette(page, 'Settings: Risk');
    await shot(page, 'settings-risk');
    await palette(page, 'Settings: Performance');
    await shot(page, 'settings-performance');
    await reset(page);
  });
  await part('logs', async () => {
    await palette(page, 'Open Logs');
    await shot(page, 'logs-window');
    await reset(page);
  });

  // ------------------------------------------------------------------ guide itself
  await part('guide', async () => {
    await page.keyboard.press('F1');
    await page.getByTestId('user-guide').waitFor();
    await shot(page, 'user-guide');
    await reset(page);
  });

  // ------------------------------------------------------------------ generated shortcut table
  await part('shortcuts', async () => {
    const cmds = await page.evaluate(async () => {
      const m = await import('/src/shell/commands.ts');
      return m
        .registeredCommands()
        .filter((c) => c.shortcut)
        .map((c) => ({
          keys: m.normalizeShortcut(c.shortcut!),
          label: c.label,
          group: c.group,
          scope: c.scope ?? 'global',
        }));
    });
    const groups = new Map<string, typeof cmds>();
    for (const c of cmds) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    const lines: string[] = [];
    for (const [g, list] of groups) {
      lines.push(`#### ${g}`, '', '| Keys | Command | Active in |', '| --- | --- | --- |');
      for (const c of list) lines.push(`| \`${c.keys}\` | ${c.label} | ${c.scope} |`);
      lines.push('');
    }
    const file = resolve(DOCS, '16-keyboard-shortcuts.md');
    const src = readFileSync(file, 'utf8');
    const out = src.replace(
      /<!-- shortcuts:begin -->[\s\S]*?<!-- shortcuts:end -->/,
      `<!-- shortcuts:begin -->\n${lines.join('\n')}\n<!-- shortcuts:end -->`,
    );
    if (out !== src) writeFileSync(file, out);
  });

  expect(errors).toEqual([]);
  expect(failures, 'guide screenshot failures').toEqual([]);
});
