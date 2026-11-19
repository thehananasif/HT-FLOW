import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Leftover Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('double-clicked .htstrat file opens in the HT Editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'leftover1');

  const text = JSON.stringify({
    format: 'htstrat',
    version: 1,
    id: 'stg-from-disk',
    name: 'Opened from disk',
    files: [{ name: 'strategy.ts', source: '// opened from disk\nexport function onBar() {}\n' }],
    params: {},
    createdAt: 1,
    updatedAt: 1,
  });
  await page.evaluate((t) => {
    window.dispatchEvent(
      new CustomEvent('htflow:inject-file', {
        detail: {
          path: 'C:\\x\\disk.htstrat',
          name: 'disk.htstrat',
          ext: 'htstrat',
          kind: 'strategy',
          text: t,
          error: null,
        },
      }),
    );
  }, text);

  const ed = page.getByTestId('ht-editor');
  await expect(ed).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ht-editor-code')).toContainText('opened from disk');
  await expect(page.getByText('Opened Opened from disk in HT Editor')).toBeVisible();
  expect(errors).toEqual([]);
});

test('COT chart in the web build downloads from the CFTC API with a browser fetch', async ({
  page,
}) => {
  const urls: string[] = [];
  const row = (date: string) => ({
    report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
    open_interest_all: '2603046',
    change_in_open_interest_all: '1000',
    dealer_positions_long_all: '548735',
    dealer_positions_short_all: '156360',
    asset_mgr_positions_long: '937649',
    asset_mgr_positions_short: '100',
  });
  await page.route('https://publicreporting.cftc.gov/**', async (route) => {
    urls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([row('2026-10-27'), row('2026-11-03')]),
    });
  });
  await createAccount(page, 'leftover3');
  await page.getByTestId('template-menu').first().click();
  await page.getByRole('menuitem', { name: 'COT Chart', exact: true }).click();
  await expect(page.getByTestId('chart-cot')).toBeVisible();
  const status = page.getByTestId('cot-status');
  await expect(status).toHaveAttribute('data-status', 'ready');
  await expect(status).toContainText('as of 2026-11-03');
  await expect(page.getByText('Sample data')).toHaveCount(0);
  expect(urls.length).toBeGreaterThan(0);
  expect(urls[0]).toContain('/resource/');
});

test('HT Editor plot() lines are drawn on the instrument chart during a paper run, removable', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'leftover4');
  const source = [
    "export const meta = { name: 'Plotter', timeframe: '1m' };",
    'export function onTick(tick) {',
    "  plot('Price', tick.price, { color: '#ff00ff' });",
    '}',
    '',
  ].join('\n');
  await page.evaluate((src) => {
    window.dispatchEvent(
      new CustomEvent('htflow:inject-file', {
        detail: {
          path: 'C:\\x\\plotter.htstrat',
          name: 'plotter.htstrat',
          ext: 'htstrat',
          kind: 'strategy',
          text: JSON.stringify({
            format: 'htstrat',
            version: 1,
            id: 'stg-plotter',
            name: 'Plotter',
            files: [{ name: 'strategy.ts', source: src }],
            params: {},
            createdAt: 1,
            updatedAt: 1,
          }),
          error: null,
        },
      }),
    );
  }, source);
  const ed = page.getByTestId('ht-editor');
  await expect(ed).toBeVisible({ timeout: 15_000 });
  await expect(ed.getByText('Compiled')).toBeVisible();
  // The sandbox loads slowly while the page is still busy loading history right after login.
  await page.waitForTimeout(12_000);
  // Plot on the instrument the main chart shows (mock:CLZ6 by default).
  await ed.getByLabel('Instrument').selectOption('mock:CLZ6');
  await page.getByTestId('hte-paper').click();
  const runs = page.getByTestId('hte-runs');
  await expect(runs.getByText('running')).toBeVisible({ timeout: 30_000 });

  // Count magenta pixels on the chart canvases (the plot line colour).
  const magenta = () =>
    page.evaluate(() => {
      let n = 0;
      for (const c of Array.from(document.querySelectorAll('canvas'))) {
        if (c.getAttribute('aria-label') === 'Strategy plots') continue;
        const g = c.getContext('2d');
        if (!g || !c.width || !c.height) continue;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4)
          if (
            d[i]! > 130 &&
            d[i + 2]! > 130 &&
            d[i + 1]! < d[i]! - 70 &&
            d[i + 2]! > d[i + 1]! + 70
          )
            n++;
      }
      return n;
    });
  await expect.poll(magenta, { timeout: 30_000 }).toBeGreaterThan(5);

  // Removable: hide the run's plots, then they disappear from the chart.
  await runs.getByTestId('hte-run-plots').click();
  await expect(runs.getByTestId('hte-run-plots')).toHaveText('Show plots');
  await expect.poll(magenta, { timeout: 10_000 }).toBe(0);
  await runs.getByTestId('hte-run-plots').click();
  // The chart repaints on its own schedule (rAF under CPU load can take many seconds).
  await expect.poll(magenta, { timeout: 30_000 }).toBeGreaterThan(5);

  // Stopping the run removes the overlay.
  await runs.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(magenta, { timeout: 10_000 }).toBe(0);
  expect(errors).toEqual([]);
});

test('Trading Panel: drag handle resizes (min 240), keyboard nudges, double-click resets', async ({
  page,
}) => {
  await createAccount(page, 'leftover2');
  const panel = page.getByTestId('trading-panel');
  const handle = page.getByTestId('trading-resize');
  const width = async () => Math.round((await panel.boundingBox())!.width);
  expect(await width()).toBe(262);

  const hb = (await handle.boundingBox())!;
  const y = hb.y + hb.height / 2;
  const x = hb.x + hb.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(width).toBe(362);

  // Cannot go below the 240 px minimum.
  const hb2 = (await handle.boundingBox())!;
  await page.mouse.move(hb2.x + hb2.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(hb2.x + 400, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(width).toBe(240);

  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(256);
  await handle.dblclick();
  await expect.poll(width).toBe(262);
});
