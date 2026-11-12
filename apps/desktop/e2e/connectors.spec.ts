import { expect, test } from '@playwright/test';

test('crypto connectors from P05 are available in the add-connection wizard', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Venue Tester');
  await inputs.nth(1).fill('venuetester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('ribbon-connections').click();
  await page.getByRole('button', { name: '+ Add connection' }).click();
  for (const name of ['OKX', 'Deribit', 'Bitget', 'Kraken', 'Bitfinex', 'Phemex', 'Whitebit']) {
    await page.getByLabel('Search providers').fill(name.toLowerCase());
    await page.getByRole('button', { name: new RegExp(`^${name}\\s*FREE$`) }).click();
    await expect(page.getByText(/Step 2 of 2/).first()).toBeVisible();
    await expect(page.getByText(/Free public market data/).first()).toBeVisible();
    await expect(page.getByText(/Coming soon/)).toHaveCount(0);
  }
  await page.getByLabel('Search providers').fill('coin-m');
  await expect(page.getByRole('button', { name: /^Binance COIN-M\s*FREE$/ })).toBeVisible();
});
