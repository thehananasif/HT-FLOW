import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Backfill Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

// P06 / P27: the native backfill itself needs the desktop core (Rust tests cover it with a mock
// HTTP server); the browser preview checks the settings it reads are live and complete.
test('data settings: provider priority lists every venue, cache size is wired', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'backfill1');

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  const win = page.getByTestId('settings-window');
  await expect(win).toBeVisible();
  await win.getByRole('button', { name: 'Data', exact: true }).click();

  const table = win.getByTestId('provider-priority');
  await expect(table).toBeVisible();
  for (const id of ['binance-futures', 'binance-spot', 'binance-coinm', 'okx-swap', 'mock'])
    await expect(table.getByRole('cell', { name: id, exact: true })).toBeVisible();

  // Cache size is editable and nothing in the Data section is flagged "stored only" any more.
  const cache = win.getByRole('textbox', { name: 'Cache size' });
  await cache.scrollIntoViewIfNeeded();
  await expect(cache).toHaveValue('512');
  await cache.fill('1024');
  await cache.press('Tab');
  await expect(cache).toHaveValue('1024');
  await expect(win.getByText('the module that uses it is not built yet')).toHaveCount(0);

  expect(errors).toEqual([]);
});
