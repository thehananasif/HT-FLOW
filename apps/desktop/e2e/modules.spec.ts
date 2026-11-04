import { expect, test } from '@playwright/test';

test('ribbon modules open registered windows and placeholders', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Mod Tester');
  await inputs.nth(1).fill('modtester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('ribbon-positions').click();
  await expect(page.getByText('No open positions')).toBeVisible();
  await page.getByTestId('ribbon-connections').click();
  await expect(page.getByText('Providers')).toBeVisible();
  await page.getByTestId('ribbon-options-board').click();
  await expect(page.getByText(/phase P18/)).toBeVisible();
});
