import { expect, test } from '@playwright/test';

test('indicators: Spread with a second symbol, Custom Formula editor, account indicators', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Second Tester');
  await inputs.nth(1).fill('secondtester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500);

  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  const search = dlg.getByPlaceholder('Search indicators…');

  // Spread: no longer pending; add it and pick a second symbol with the symbol picker.
  await search.fill('Spread');
  const add = dlg.getByRole('button', { name: 'Add Spread (two instruments)' });
  await expect(add).toBeEnabled();
  await add.click();
  await dlg.getByTestId('ind-instrument').click();
  const picker = page.getByTestId('instrument-picker-popover');
  await picker.getByLabel('Has live feed').check();
  const row = picker.getByRole('option').filter({ hasText: 'ESZ6' }).first();
  await expect(row).toContainText('Sim');
  await row.dblclick();
  await expect(dlg.getByTestId('ind-instrument')).not.toHaveText(/Pick an instrument/);

  // Custom Formula: editor dialog with a syntax error and a live preview.
  await search.fill('Custom Formula');
  await dlg.getByRole('button', { name: 'Add Custom Formula (expression editor)' }).click();
  await dlg.getByTestId('formula-edit').click();
  const text = page.getByTestId('formula-text');
  await text.fill('close +');
  await expect(page.getByTestId('formula-status')).toContainText('Error');
  await text.fill('close - ref(close, 1)');
  await expect(page.getByTestId('formula-status')).toContainText('Formula OK');
  await expect(page.getByTestId('formula-preview').locator('tbody tr')).not.toHaveCount(0);
  await page.getByTestId('formula-apply').click();
  await expect(dlg.getByRole('textbox', { name: 'Formula' })).toHaveValue('close - ref(close, 1)');

  // Account indicators are available too.
  await search.fill('Account Info');
  await expect(dlg.getByRole('button', { name: 'Add Account Info Display' })).toBeEnabled();
  await search.fill('Position Sizing');
  await expect(dlg.getByRole('button', { name: 'Add Position Sizing Tracker' })).toBeEnabled();

  await page.getByTestId('indicators-apply').click();
  const legend = page.getByTestId('indicator-legend').first();
  await expect(legend.getByText(/^Spread vs /)).toBeAttached();
  await expect(legend.getByText(/^ƒ /)).toBeAttached();
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});
