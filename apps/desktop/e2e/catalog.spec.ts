import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Catalog Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByTestId('recovery-code').locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('picker: search "crude", open CL (Sim); no-feed futures offer Connections', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'catalog1');
  // Start from another instrument so the switch to CL is visible.
  await page.getByTestId('instrument-picker').first().click();
  const picker = page.getByTestId('instrument-picker-popover');
  await picker.getByLabel('Search instruments').fill('nq');
  await picker.getByRole('option').filter({ hasText: 'E-mini Nasdaq-100' }).first().dblclick();
  await expect(page.getByTestId('instrument-picker').first()).toContainText('NQZ6');

  await page.getByTestId('instrument-picker').first().click();
  await picker.getByLabel('Search instruments').fill('crude');
  const cl = picker.getByRole('option').filter({ hasText: 'Light Sweet Crude' });
  await expect(cl).toContainText('Sim');
  await cl.click();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('instrument-picker').first()).toContainText('CLZ6');

  // A catalog future without a feed cannot be opened: the picker offers Connections.
  await page.getByTestId('instrument-picker').first().click();
  await picker.getByLabel('Search instruments').fill('corn');
  const zc = picker
    .getByRole('option')
    .filter({ hasText: /^.*ZC.*Corn/ })
    .first();
  await expect(zc).toContainText('No feed');
  await zc.dblclick();
  await expect(picker.getByRole('alert')).toContainText('has no feed');
  await picker.getByRole('button', { name: 'Open Connections' }).click();
  await expect(page.getByText('Providers')).toBeVisible();
  expect(errors).toEqual([]);
});

test('watchlist: add a symbol; forward curve opens with Sim badge', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'catalog2');
  await page.getByTestId('ribbon-watchlist').click();
  const wl = page.getByTestId('watchlist');
  await expect(wl).toBeVisible();
  await wl.getByRole('tab', { name: 'Futures' }).click();
  await expect(wl.getByTestId('wl-row-CL')).toBeVisible();
  await expect(wl.getByTestId('wl-row-ZN')).toContainText('No feed');
  await wl.getByTestId('wl-add-symbol').click();
  const picker = page.getByTestId('instrument-picker-popover');
  await picker.getByLabel('Search instruments').fill('micro e-mini s&p');
  await picker.getByRole('option').filter({ hasText: 'Micro E-mini S&P 500' }).first().dblclick();
  await expect(wl.getByTestId('wl-row-MES')).toBeVisible();
  // CL streams from the simulator: Last becomes a price.
  await expect(wl.getByTestId('wl-row-CL').locator('.wl-last')).toHaveText(/\d+\.\d{2}/, {
    timeout: 15_000,
  });

  await page.getByTestId('ribbon-forward-curve').click();
  const fc = page.getByTestId('forward-curve');
  await expect(fc).toBeVisible();
  await expect(fc.getByText('Sim', { exact: true })).toBeVisible();
  await expect(fc.getByTestId('fc-roll')).toContainText('Next roll: CL');
  await fc.getByRole('button', { name: 'BTC quarterly' }).click();
  await expect(fc.locator('td', { hasText: /BTCUSDT_\d{6}/ }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
