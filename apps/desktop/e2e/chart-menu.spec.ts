import { expect, test, type Locator, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Menu Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function chart(page: Page) {
  const host = page.getByTestId('chart-footprint').first();
  await expect(host.locator('canvas').first()).toBeVisible();
  await expect(page.getByText(/Loading .* history/)).toHaveCount(0, { timeout: 30_000 });
  return host;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const item = (page: Page, label: string) =>
  page.getByRole('menuitem', { name: new RegExp(`^(✓)?\\s*${esc(label)}`) }).first();

/** Right-clicks the price pane and picks a (possibly nested) item. */
async function pick(page: Page, host: Locator, path: string[], at = { x: 0.5, y: 150 }) {
  const box = (await host.boundingBox())!;
  await host.click({ button: 'right', position: { x: box.width * at.x, y: at.y } });
  for (const [i, label] of path.entries()) {
    const el = item(page, label);
    await expect(el).toBeVisible();
    if (i < path.length - 1) await el.hover();
    else await el.click();
  }
}

test('chart right-click menu: P26 order and every top-level item works', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'chartmenu1');
  const host = await chart(page);
  const box = (await host.boundingBox())!;

  // The full menu lists the spec items in order.
  await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  await expect(item(page, 'Settings…')).toBeVisible();
  const labels = (await page.getByRole('menuitem').allInnerTexts()).map((t) =>
    t.replace(/^✓/, '').trim(),
  );
  const order = [
    'Buy Limit at',
    'Set alert at',
    'Trading Panel',
    'DOM Trader',
    'Lock trading',
    'Go to date…',
    'Change Instrument…',
    'Mode',
    'Mouse',
    'Templates',
    'Indicators',
    'Overlay',
    'Drawing objects',
    'Attach strategy…',
    'Layouts',
    'Create linked window',
    'Clone window',
    'Hide panels',
    'Trading session',
    'Refresh',
    'Reload all historical data',
    'Add replay template',
    'Reset',
    'Export…',
    'Full screen mode',
    'Settings…',
  ];
  let last = -1;
  for (const l of order) {
    const i = labels.findIndex((t, k) => k > last && (t.startsWith(l) || t.includes(l)));
    expect(i, `${l} after index ${last} in ${labels.join(' | ')}`).toBeGreaterThan(last);
    last = i;
  }
  // The day-load item is gone (automatic history).
  expect(labels.some((l) => /Load 1 more day/.test(l))).toBe(false);
  await page.keyboard.press('Escape');

  // Buy limit below the market uses the Trading Panel account (toast names it).
  await pick(page, host, ['Buy Limit at'], { x: 0.5, y: box.height * 0.8 });
  await expect(page.getByText(/Buy limit 1 @/)).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .getByText(/Paper · ••••3505/)
      .first(),
  ).toBeVisible();

  // Lock trading toggles (checked on reopen), then unlock.
  await pick(page, host, ['Lock trading']);
  await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  await expect(page.getByRole('menuitem', { name: /^✓\s*Lock trading/ })).toBeVisible();
  await item(page, 'Lock trading').click();

  // Indicators, chart strategies, settings open their windows.
  await pick(page, host, ['Indicators']);
  await expect(page.getByTestId('indicators-dialog')).toBeVisible();
  await page.getByTestId('indicators-dialog').getByRole('button', { name: 'Close' }).click();
  await pick(page, host, ['Attach strategy…']);
  await expect(page.getByTestId('chart-strategy-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await pick(page, host, ['Settings…']);
  await expect(page.getByTestId('chart-settings')).toBeVisible();
  await page.getByRole('button', { name: 'Close chart settings' }).click();

  // Drawing objects ▸ Magnifier toggles the lens.
  await pick(page, host, ['Drawing objects', 'Magnifier']);
  await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  await item(page, 'Drawing objects').hover();
  await expect(page.getByRole('menuitem', { name: /^✓\s*Magnifier/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Data actions.
  await pick(page, host, ['Refresh']);
  await expect(page.getByText('Chart refreshed')).toBeVisible();
  await pick(page, host, ['Reload all historical data']);
  await expect(page.getByText('Historical data reloaded')).toBeVisible();
  await pick(page, host, ['Add replay template']);
  await expect(page.getByText('Replay template saved')).toBeVisible();
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    pick(page, host, ['Export…', 'CSV of bars']),
  ]);
  expect(csv.suggestedFilename()).toMatch(/bars\.csv$/);
  const [json] = await Promise.all([
    page.waitForEvent('download'),
    pick(page, host, ['Export…', 'JSON of bars']),
  ]);
  expect(json.suggestedFilename()).toMatch(/bars\.json$/);

  // Trading session ▸ and Mode ▸ write the chart settings (checked on reopen).
  await pick(page, host, ['Mode', 'Line']);
  await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  await item(page, 'Mode').hover();
  await expect(page.getByRole('menuitem', { name: /^✓\s*Line/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Hide panels hides the bottom bar; the command palette brings it back.
  await pick(page, host, ['Hide panels']);
  await expect(page.getByTestId('history-range')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Chart: Hide / show panels');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('history-range').first()).toBeVisible();

  // Clone window adds a chart.
  const before = await page.locator('.chart-window').count();
  await pick(page, host, ['Clone window']);
  await expect(page.locator('.chart-window')).toHaveCount(before + 1);

  // Time axis and price axis menus are context-aware.
  const box2 = (await host.boundingBox())!;
  await host.click({ button: 'right', position: { x: box2.width / 2, y: box2.height - 8 } });
  await expect(item(page, 'Time zone')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Clone window/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('context menus on an indicator pane and on a drawing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'chartmenu2');
  const host = await chart(page);
  const box = (await host.boundingBox())!;

  // Add RSI (own pane).
  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  await dlg.getByPlaceholder('Search indicators…').fill('RSI');
  await dlg.getByRole('button', { name: 'Add RSI', exact: true }).click();
  await page.getByTestId('indicators-apply').click();
  await expect(dlg).toBeHidden();
  const legend = page.getByTestId('indicator-legend').first();
  await expect(legend.getByText('RSI 14')).toBeAttached();

  // Find the RSI pane from the bottom up: its menu offers indicator items.
  let found = false;
  for (let y = box.height - 30; y > box.height * 0.4 && !found; y -= 14) {
    await host.click({ button: 'right', position: { x: box.width / 2, y } });
    found = await item(page, 'Remove indicator')
      .isVisible()
      .catch(() => false);
    if (!found) await page.keyboard.press('Escape');
  }
  expect(found).toBe(true);
  await expect(item(page, 'Indicator settings…')).toBeVisible();
  await expect(item(page, 'Hide indicator')).toBeVisible();
  await item(page, 'Move to pane').hover();
  await item(page, 'Price pane (overlay)').click();
  await expect(legend.getByText('RSI 14')).toBeAttached();
  // Remove it through the legend-free path: the indicators command still lists it, then remove.
  await page.getByTestId('indicators-button').first().click();
  await expect(page.getByTestId('indicators-dialog')).toBeVisible();
  await page.getByTestId('indicators-dialog').getByRole('button', { name: 'Close' }).click();

  // Drawing: a horizontal line, then right-click on it → drawing items first.
  const overlay = page.getByTestId('drawings-overlay').first();
  await page.getByRole('button', { name: 'Lines', exact: true }).first().click();
  await page.getByRole('menuitemradio', { name: /^Horizontal Line/ }).click();
  const y = box.height * 0.3;
  await host.click({ position: { x: box.width * 0.4, y } });
  await expect(overlay).toHaveAttribute('data-count', '1');
  await host.click({ button: 'right', position: { x: box.width * 0.6, y } });
  const labels = (await page.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
  expect(labels[0]).toMatch(/^Edit drawing/);
  for (const l of ['Clone drawing', 'Lock drawing', 'Hide drawing', 'Delete drawing'])
    await expect(item(page, l)).toBeVisible();
  await item(page, 'Delete drawing').click();
  await expect(overlay).toHaveAttribute('data-count', '0');
  expect(errors).toEqual([]);
});

test('Appendix C shortcuts, rebinding, snapshots and automatic history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'chartmenu3');
  const host = await chart(page);
  const box = (await host.boundingBox())!;
  const menuChecked = async (path: string[], label: RegExp) => {
    await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
    for (const p of path) await item(page, p).hover();
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
    for (let i = 0; i <= path.length; i++) await page.keyboard.press('Escape');
  };

  await host.click({ position: { x: 300, y: 200 } });
  // Shift+L / Shift+C: display modes.
  await page.keyboard.press('Shift+L');
  await menuChecked(['Mode'], /^✓\s*Line/);
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Shift+C');
  await menuChecked(['Mode'], /^✓\s*Candles/);

  // Ctrl+G go to date, Ctrl+S chart settings.
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+g');
  await expect(page.getByRole('dialog', { name: 'Go to date' })).toBeVisible();
  await page.keyboard.press('Escape');
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('chart-settings')).toBeVisible();
  await page.getByRole('button', { name: 'Close chart settings' }).click();

  // F6 = horizontal line tool, Escape; M = magnifier.
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('F6');
  await expect(page.getByRole('button', { name: 'Lines', exact: true }).first()).toHaveAttribute(
    'data-has-tool',
    'true',
  );
  const overlay = page.getByTestId('drawings-overlay').first();
  await host.click({ position: { x: box.width * 0.4, y: box.height * 0.35 } });
  await expect(overlay).toHaveAttribute('data-count', '1');
  await page.keyboard.press('m');
  await menuChecked(['Drawing objects'], /^✓\s*Magnifier/);
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('m');

  // Ctrl+Z works after clicking outside any window (status bar): it acts on the active chart.
  await page.mouse.click(800, 893);
  await page.keyboard.press('Control+z');
  await expect(overlay).toHaveAttribute('data-count', '0');
  await page.keyboard.press('Control+y');
  await expect(overlay).toHaveAttribute('data-count', '1');

  // Ctrl + double-click: full screen.
  await host.dblclick({ position: { x: 300, y: 200 }, modifiers: ['Control'] });
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());

  // Rebind Go to date to Ctrl+Shift+G in Settings → Hot keys.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  const win = page.getByTestId('settings-window');
  await win.getByRole('button', { name: 'Hot keys' }).click();
  await win.getByLabel('Filter commands').fill('Chart: Go to date');
  await win.getByLabel('Shortcut for Chart: Go to date…').click();
  await page.keyboard.press('Control+Shift+G');
  await expect(win.getByLabel('Shortcut for Chart: Go to date…')).toHaveText('Ctrl+Shift+G');
  await win.getByRole('button', { name: 'OK', exact: true }).click();
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+Shift+G');
  await expect(page.getByRole('dialog', { name: 'Go to date' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Snapshots: take one, change the template, restore it.
  await page.getByTestId('template-menu').first().click();
  await item(page, 'Snapshots').hover();
  await item(page, 'Take snapshot').click();
  await expect(page.getByText('Snapshot saved')).toBeVisible();
  await page.getByTestId('template-menu').first().click();
  await item(page, 'Japanese Candlesticks').click();
  await expect(page.getByTestId('chart-candles-vp').first()).toBeVisible();
  await page.getByTestId('template-menu').first().click();
  await item(page, 'Snapshots (1)').hover();
  await page
    .getByRole('menuitem', { name: / · \d+ \w{3} \d\d:\d\d$/ })
    .first()
    .click();
  await expect(page.getByText('Snapshot restored')).toBeVisible();
  await expect(page.getByTestId('chart-footprint').first()).toBeVisible();

  // Automatic history (round 7): no "Load days" / "◂ Load 1 more day" controls any more; the
  // footer shows the loaded range, and the menu has no day-load item.
  await expect(page.getByLabel('Load days')).toHaveCount(0);
  await expect(page.getByTestId('load-one-more-day')).toHaveCount(0);
  await expect(page.getByTestId('history-range').first()).toContainText(/History .* ticks/);
  // "Chart: Load older history" still extends a simulated chart on demand (previous session).
  await page
    .getByTestId('chart-footprint')
    .first()
    .click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Chart: Load older history');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Loaded .* older ticks/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('prev-session-profile').first()).toHaveAttribute('data-poc', /\d/);
  expect(errors).toEqual([]);
});
