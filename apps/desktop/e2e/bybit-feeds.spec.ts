import { expect, test, type Page } from '@playwright/test';

// Bybit spot and inverse stream through the Rust connector (desktop app). In the browser preview
// their catalog entries must say "Desktop app" (a connector exists) instead of "No feed", and the
// Connections catalog must list both as available crypto providers.
async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Bybit Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('picker: Bybit spot and inverse symbols have a feed (desktop app), not "No feed"', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'bybitfeeds1');
  await page.getByTestId('instrument-picker').first().click();
  const picker = page.getByTestId('instrument-picker-popover');
  const search = picker.getByLabel('Search instruments');

  await search.fill('Bybit Spot');
  const spot = picker.getByRole('option').filter({ hasText: 'BTCUSDT' }).filter({
    hasText: 'Bitcoin Spot',
  });
  await expect(spot.first()).toContainText('Desktop app');
  await expect(spot.first()).not.toContainText('No feed');

  await search.fill('Bybit Inverse');
  const inv = picker.getByRole('option').filter({ hasText: 'BTCUSD' }).filter({
    hasText: 'Inverse perpetual',
  });
  await expect(inv.first()).toContainText('Desktop app');
  await expect(inv.first()).not.toContainText('No feed');
  expect(errors).toEqual([]);
});
