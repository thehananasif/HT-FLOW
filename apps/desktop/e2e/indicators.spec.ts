import { expect, test } from '@playwright/test';

test('indicators dialog: add EMA and RSI, legend lists them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Ind Tester');
  await inputs.nth(1).fill('indtester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500); // history load

  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: /^Technical/ }).click();
  await dlg.getByRole('button', { name: 'Add EMA', exact: true }).click();
  await dlg.getByLabel('Period').fill('34');
  await dlg.getByLabel('Period').press('Enter');
  await dlg.getByPlaceholder('Search indicators…').fill('RSI');
  await dlg.getByRole('button', { name: 'Add RSI', exact: true }).click();
  await dlg.getByRole('tab', { name: 'Style' }).click();
  await dlg.getByRole('tab', { name: 'Advanced' }).click();
  await page.getByTestId('indicators-apply').click();
  await expect(dlg).toBeHidden();

  const legend = page.getByTestId('indicator-legend').first();
  await expect(legend.getByText('EMA 34')).toBeAttached();
  await expect(legend.getByText('RSI 14')).toBeAttached();
  await expect(page.getByTestId('indicators-button').first()).toHaveText('Indicators (2)');
  await page.screenshot({ path: 'test-results/indicators.png' });
  expect(errors).toEqual([]);
});
