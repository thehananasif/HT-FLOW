import { expect, test, type Page } from '@playwright/test';

/** Rows in the shape of the native `cot_fetch` result (taken from a real TFF response). */
const MOCK = `
  window.__cotCalls = [];
  const grp = (key, label, long, short, d) => ({ key, label, long, short, spread: 0, net: long - short, longChange: 0, shortChange: 0, netChange: d });
  const rows = ['2026-10-20', '2026-10-27', '2026-11-03'].map((date, i) => ({
    date, openInterest: 1900000 + i * 1000, oiChange: 1000,
    groups: [
      grp('dealer', 'Dealers / intermediaries', 184740, 821671, -3000),
      grp('assetmgr', 'Asset managers', 1101642, 400000, 5000),
      grp('levmoney', 'Leveraged funds', 100000, 450000, -2000),
      grp('other', 'Other reportables', 90000, 80000, 100),
      grp('nonreportable', 'Non-reportable', 50000, 40000, 0),
    ],
  }));
  window.__HTFLOW_COT_MOCK__ = async (a) => {
    window.__cotCalls.push(a);
    if (window.__cotMode === 'offline') throw { code: 'cot.network', message: 'Could not connect to the CFTC' };
    return { rows, fetchedAt: Date.now(), source: 'network' };
  };
`;

async function createAccount(page: Page, username: string, mode = 'ok') {
  await page.addInitScript(`window.__cotMode = '${mode}'; ${MOCK}`);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('COT Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cotCalls: Record<string, unknown>[] }).__cotCalls);

async function openCot(page: Page) {
  await page.getByTestId('template-menu').first().click();
  await page.getByRole('menuitem', { name: 'COT Chart', exact: true }).click();
  await expect(page.getByTestId('chart-cot')).toBeVisible();
}

test('COT chart shows real (mocked native) data, switches market and report, refreshes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'cot1');
  await openCot(page);

  const status = page.getByTestId('cot-status');
  await expect(status).toHaveAttribute('data-status', 'ready');
  await expect(status).toContainText('as of 2026-11-03');
  await expect(page.getByText('Sample data')).toHaveCount(0);
  const first = (await calls(page))[0]!;
  expect(first).toMatchObject({ force: false });
  expect(String(first.fromDate)).toMatch(/^\d{4}-01-01$/);

  // Financial futures use TFF by default.
  await page.getByTestId('cot-market').selectOption('ES');
  await expect(page.getByTestId('cot-report')).toHaveValue('tff');
  await expect
    .poll(async () => (await calls(page)).at(-1))
    .toMatchObject({ report: 'tff', marketCode: '13874A' });

  // Market picker: gold only has Legacy / Disaggregated, so the report follows.
  await page.getByTestId('cot-market').selectOption('GC');
  await expect(page.getByTestId('cot-report')).toHaveValue('disagg');
  await expect
    .poll(async () => (await calls(page)).at(-1))
    .toMatchObject({
      report: 'disagg',
      marketCode: '088691',
    });
  await page.getByTestId('cot-report').selectOption('legacy');
  await expect.poll(async () => (await calls(page)).at(-1)).toMatchObject({ report: 'legacy' });

  // Refresh button forces a download.
  await page.getByTestId('cot-refresh').click();
  await expect.poll(async () => (await calls(page)).at(-1)).toMatchObject({ force: true });

  // Command Palette: Refresh COT data
  const before = (await calls(page)).length;
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('Refresh COT');
  await palette.getByRole('option').filter({ hasText: 'Refresh COT data' }).first().click();
  await expect.poll(async () => (await calls(page)).length).toBeGreaterThan(before);
  expect((await calls(page)).at(-1)).toMatchObject({ force: true });
  expect(errors).toEqual([]);
});

test('COT chart offline with no cache shows the labelled sample data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'cot2', 'offline');
  await openCot(page);
  await expect(page.getByTestId('cot-status')).toHaveAttribute('data-status', 'offline');
  await expect(page.getByText('Sample data')).toBeVisible();
  await expect(page.getByTestId('cot-status')).toContainText('Offline');
  expect(errors).toEqual([]);
});

test('COT settings: default report and weekly auto-refresh are in Settings', async ({ page }) => {
  await createAccount(page, 'cot3');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  const win = page.getByTestId('settings-window');
  await expect(win).toBeVisible();
  await win.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(win.getByText('Default COT report').first()).toBeAttached();
  await expect(win.getByText('Refresh COT data weekly').first()).toBeAttached();
});
