import { expect, test } from '@playwright/test';

test('indicators P13: formula, alerts tab, timeframe override, sandboxed script editor', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Script Tester');
  await inputs.nth(1).fill('scripttester');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500);

  // Custom Formula (P14) + Alerts tab + timeframe override.
  await page.getByTestId('indicators-button').first().click();
  const dlg = page.getByTestId('indicators-dialog');
  await dlg.getByPlaceholder('Search indicators…').fill('Custom Formula');
  await dlg.getByRole('button', { name: 'Add Custom Formula (expression editor)' }).click();
  await dlg.getByRole('tab', { name: 'Alerts' }).click();
  await dlg.getByTestId('ind-add-alert').click();
  await expect(dlg.getByTestId('ind-alert-row')).toHaveCount(1);
  await dlg.getByLabel('Alert level').fill('1.5');
  await dlg.getByLabel('Alert level').press('Enter');
  await expect(dlg.getByRole('tab', { name: 'Alerts (1)' })).toBeVisible();
  await dlg.getByRole('tab', { name: 'Advanced' }).click();
  await dlg.getByLabel('Indicator timeframe').selectOption('H1');
  await expect(dlg.getByLabel('Higher-timeframe bar')).toBeVisible();
  await expect(dlg.getByLabel('Data source')).toBeVisible();

  // Script editor from the Custom category.
  await dlg.getByRole('button', { name: /^Custom \(scripts\)/ }).click();
  await dlg.getByTestId('ind-new-script').click();
  await page.getByTestId('indicators-apply').click();
  const ed = page.getByTestId('script-editor');
  await expect(ed).toBeVisible();
  const src = ed.getByTestId('se-source');
  const status = ed.getByTestId('se-status');
  await expect(status).toContainText('OK');

  // The sandbox rejects network / DOM access at compile time.
  await src.fill('indicator("Leak", pane="new")\nplot("x", fetch("https://example.com"))');
  await expect(status).toContainText("Unknown function 'fetch'");
  await src.fill('indicator("Leak", pane="new")\nplot("x", document)');
  await expect(status).toContainText("Unknown name 'document'");

  await src.fill(
    'indicator("Range ratio", short="RR", pane="new")\nn = input.int("Length", 10, min=1, max=200)\nplot.line("Ratio", (high - low) / sma(high - low, n))\nhline(1)',
  );
  await expect(status).toContainText('OK · Range ratio');
  await ed.getByLabel('Script name').fill('Range ratio');
  await ed.getByTestId('se-add').click();
  await expect(ed.getByTestId('se-script')).toHaveText(['Range ratio']);

  const legend = page.getByTestId('indicator-legend').first();
  await expect(legend.getByText(/^ƒ /)).toBeAttached();
  await expect(legend.getByText('RR')).toBeAttached();
  await page.waitForTimeout(1000); // worker results arrive
  await page.screenshot({ path: 'test-results/indicators-p13.png' });

  // Persisted in the library: the dialog lists it under Custom (scripts).
  await page.getByTestId('indicators-button').first().click();
  await dlg.getByRole('button', { name: /^Custom \(scripts\)/ }).click();
  await expect(dlg.getByRole('button', { name: 'Add Range ratio' })).toBeVisible();
  await page.getByTestId('indicators-apply').click();
  expect(errors).toEqual([]);
});
