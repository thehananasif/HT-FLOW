import { expect, test } from '@playwright/test';

test('connections window, add-connection wizard and data manager', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Conn Tester');
  await inputs.nth(1).fill('conntester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('ribbon-connections').click();
  // Default connections + summary cards.
  await expect(page.getByText('Binance Futures').first()).toBeVisible();
  await expect(page.getByText('Gaps resynced today')).toBeVisible();
  await page.screenshot({ path: 'test-results/connections.png' });
  // Wizard: provider tree with spec groups, search, per-provider form.
  await page.getByRole('button', { name: '+ Add connection' }).click();
  await expect(page.getByText(/Step 1 of 2/).first()).toBeVisible();
  await expect(page.getByText('▾ Prop connections')).toBeVisible();
  await page.getByLabel('Search providers').fill('rithmic');
  await page.getByRole('button', { name: /^Rithmic\s*YOUR ACCOUNT$/ }).click();
  await expect(page.getByText(/Step 2 of 2/).first()).toBeVisible();
  await expect(page.getByText(/Coming soon \/ requires SDK/)).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.cx-test')).toContainText('Coming soon');
  await page.screenshot({ path: 'test-results/wizard.png' });
  await page.getByLabel('Search providers').fill('crypto sim');
  await page.getByRole('button', { name: /^Crypto Sim\s*FREE$/ }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Crypto Sim').first()).toBeVisible();
  // Data manager tab: the browser preview explains it is desktop-only.
  await page.getByRole('button', { name: 'Data manager' }).first().click();
  await expect(page.getByText('Data manager runs in the desktop app')).toBeVisible();
});
