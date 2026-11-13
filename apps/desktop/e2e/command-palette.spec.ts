import { expect, test } from '@playwright/test';

test('command palette: search an indicator, click it, it is added to the chart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Palette Tester');
  await inputs.nth(1).fill('palette1');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500); // history load

  await expect(page.getByTestId('indicators-button').first()).toHaveText('Indicators');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('RSI');

  // Indicators are listed under their own header, after the command results.
  await expect(palette.locator('.palette-header', { hasText: 'Indicators' })).toBeVisible();
  const rsi = palette
    .getByRole('option')
    .filter({ has: page.locator('.palette-label', { hasText: /^RSI$/ }) });
  await rsi.click();
  await expect(palette).toHaveCount(0);

  const legend = page.getByTestId('indicator-legend').first();
  await expect(legend.getByText('RSI 14')).toBeAttached();
  await expect(page.getByTestId('indicators-button').first()).toHaveText('Indicators (1)');
  expect(errors).toEqual([]);
});
