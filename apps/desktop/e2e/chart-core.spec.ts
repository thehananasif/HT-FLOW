import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Chart Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function chart(page: Page) {
  const host = page.getByTestId('chart-footprint').first();
  await expect(host.locator('canvas').first()).toBeVisible();
  await expect(page.getByText(/Loading .* history/)).toHaveCount(0, { timeout: 30_000 });
  return host;
}

test('chart settings: Ctrl+S, change a colour, save a template and load it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'chartcore1');
  const host = await chart(page);

  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+s');
  const win = page.getByTestId('chart-settings');
  await expect(win).toBeVisible();
  await expect(win.getByRole('tab', { name: 'Visual Settings' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Search filters rows across sections; change the up-candle colour (applies live).
  await win.getByLabel('Search chart settings').fill('up candle');
  const swatch = win.getByRole('button', { name: 'Up candle color', exact: true });
  await swatch.click();
  await page.getByLabel('Hex colour').fill('#123456');
  await page.keyboard.press('Enter');
  await expect(swatch).toContainText('#123456');

  // Save the chart as a template.
  await win.getByRole('button', { name: 'Save Template' }).click();
  await page.getByLabel('Template name').fill('E2E blue candles');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Template “E2E blue candles” saved')).toBeVisible();

  // Reset the tab, then load the template back from the Templates tab.
  await win.getByLabel('Search chart settings').fill('');
  await win.getByRole('button', { name: 'Reset tab to default' }).click();
  await win.getByLabel('Search chart settings').fill('up candle');
  await expect(win.getByRole('button', { name: 'Up candle color', exact: true })).not.toContainText(
    '#123456',
  );

  await win.getByRole('tab', { name: 'Templates' }).click();
  const row = win.getByTestId('template-E2E blue candles');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Load' }).click();
  await win.getByRole('tab', { name: 'Visual Settings' }).click();
  await win.getByLabel('Search chart settings').fill('up candle');
  await expect(win.getByRole('button', { name: 'Up candle color', exact: true })).toContainText(
    '#123456',
  );

  // OK keeps the change; reopening shows it persisted in the window state.
  await win.getByRole('button', { name: 'OK' }).click();
  await expect(win).toHaveCount(0);
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+s');
  await win.getByLabel('Search chart settings').fill('up candle');
  await expect(win.getByRole('button', { name: 'Up candle color', exact: true })).toContainText(
    '#123456',
  );

  // Cancel reverts live changes.
  await win.getByLabel('Search chart settings').fill('invert');
  await win.getByRole('switch', { name: 'Invert scale' }).click();
  await expect(win.getByRole('switch', { name: 'Invert scale' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await win.getByRole('button', { name: 'Cancel', exact: true }).click();
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+s');
  await win.getByLabel('Search chart settings').fill('invert');
  await expect(win.getByRole('switch', { name: 'Invert scale' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await win.getByRole('button', { name: 'Close chart settings' }).click();

  // The template is also in the header template menu.
  await page.getByTestId('template-menu').first().click();
  await expect(page.getByRole('menuitem', { name: /E2E blue candles/ })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('chart core: context menu items, go to date, data window, scales', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'chartcore2');
  const host = await chart(page);
  const box = (await host.boundingBox())!;

  // Price pane: full menu.
  await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  for (const label of [
    'Go to date…',
    'Change Instrument…',
    'Templates',
    'Overlay',
    'Layouts',
    'Create linked window',
    'Clone window',
    'Hide panels',
    'Trading session',
    'Refresh',
    'Reload all historical data',
    'Export…',
    'Full screen mode',
    'Settings…',
  ])
    await expect(
      page.getByRole('menuitem', {
        name: new RegExp(`^(✓ )?${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      }),
    ).toBeVisible();
  await page.getByRole('menuitem', { name: 'Go to date…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Go to date' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'First bar' }).click();
  await dlg.getByRole('button', { name: 'Go' }).click();
  await expect(dlg).toHaveCount(0);

  // Price axis: scale menu (context-aware).
  await host.click({ button: 'right', position: { x: box.width - 20, y: 150 } });
  await expect(page.getByRole('menuitem', { name: 'Logarithmic' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Go to date…' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Logarithmic' }).click();

  // Ctrl+G opens Go to date, data window toggles from the bottom bar.
  await host.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Control+g');
  await expect(page.getByRole('dialog', { name: 'Go to date' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Data window', exact: true }).first().click();
  await expect(page.getByTestId('data-window')).toContainText('Close');
  await expect(page.getByTestId('data-window')).toContainText('Delta');

  // Command palette has the chart commands.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Chart scale: Invert');
  await expect(page.getByText('Chart scale: Invert').first()).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
