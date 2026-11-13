import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Footprint Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('footprint quick settings: value area, filters, presets save / load / delete', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'fpquick1');
  const host = page.getByTestId('chart-footprint').first();
  await expect(host.locator('canvas').first()).toBeVisible();

  await page.getByRole('button', { name: 'Footprint quick settings' }).first().click();
  const dlg = page.getByTestId('fp-quick');
  await expect(dlg).toBeVisible();

  // Value area per bar + horizontal imbalance + a volume filter apply live.
  const va = dlg.getByLabel('Per bar', { exact: true });
  await va.check();
  await expect(va).toBeChecked();
  await dlg.getByLabel('Imbalance direction').selectOption('horizontal');
  const minVol = dlg.getByLabel('Minimum cell volume');
  await minVol.fill('7');
  await minVol.blur();

  // Save as a preset; it appears in the list.
  await dlg.getByLabel('Preset name').fill('E2E preset');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg.getByLabel('Footprint preset')).toContainText('E2E preset');

  // Load a built-in preset: the filter changes.
  await dlg.getByLabel('Footprint preset').selectOption({ label: 'Big clusters only (built-in)' });
  await dlg.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(minVol).toHaveValue('50');

  // Load ours back, then delete it.
  await dlg.getByLabel('Footprint preset').selectOption({ label: 'E2E preset' });
  await dlg.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(minVol).toHaveValue('7');
  await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dlg.getByLabel('Footprint preset')).not.toContainText('E2E preset');

  // Close, reopen: the chart kept the values.
  await dlg.getByTestId('fp-quick-close').click();
  await expect(dlg).toHaveCount(0);
  await page.getByRole('button', { name: 'Footprint quick settings' }).first().click();
  await expect(page.getByTestId('fp-quick').getByLabel('Per bar', { exact: true })).toBeChecked();

  // "Open full settings" goes to the Footprint tab of Chart settings.
  await page.getByRole('button', { name: 'Open full settings…' }).click();
  await expect(page.getByTestId('chart-settings')).toBeVisible();
  expect(errors).toEqual([]);
});

test('settings: default quantity and hide balances act live', async ({ page }) => {
  await createAccount(page, 'fpquick2');
  const panel = page.getByTestId('trading-panel');
  await expect(panel.getByLabel('Quantity')).toHaveValue('1');
  await expect(page.getByTestId('account-balance')).toContainText('50,000.00');

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  const win = page.getByTestId('settings-window');
  await expect(win).toBeVisible();
  await win.getByRole('button', { name: 'Trading', exact: true }).click();
  const qty = win.getByLabel('Default quantity', { exact: true });
  await qty.fill('3');
  await qty.blur();
  await win.getByRole('button', { name: 'Privacy & security', exact: true }).click();
  await win.getByLabel('Hide balances', { exact: true }).click();
  await win.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(panel.getByLabel('Quantity')).toHaveValue('3');
  await expect(page.getByTestId('account-balance')).toContainText('•••••');
});
