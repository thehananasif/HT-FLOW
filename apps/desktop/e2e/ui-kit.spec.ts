import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('UI Kit Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function logoutLogin(page: Page, username: string) {
  await page.getByTestId('account-menu').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.getByLabel('Username').fill(username);
  await page.locator('input[type=password]').fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('ribbon: hide a button, it stays hidden after login, customize + reset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'uikit1');

  const btn = page.getByTestId('ribbon-watchlist');
  await expect(btn).toBeVisible();

  // Context menu: Hide button.
  await btn.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide button' }).click();
  await expect(btn).toHaveCount(0);

  // Persisted per profile: survives logout / login and a full reload + login.
  await logoutLogin(page, 'uikit1');
  await expect(page.getByTestId('ribbon-watchlist')).toHaveCount(0);
  await expect(page.getByTestId('ribbon-chart')).toBeVisible();
  await page.reload();
  await page.getByLabel('Username').fill('uikit1');
  await page.locator('input[type=password]').fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await expect(page.getByTestId('ribbon-watchlist')).toHaveCount(0);

  // Customize dialog: bring it back, hide another, reorder.
  await page.getByTestId('ribbon-chart').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Customize ribbon…' }).click();
  const dlg = page.getByTestId('ribbon-customize');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('checkbox', { name: 'Watchlist' })).not.toBeChecked();
  await dlg.getByRole('checkbox', { name: 'Watchlist' }).check();
  await expect(page.getByTestId('ribbon-watchlist')).toBeVisible();

  const analysisBefore = await page
    .locator('.ribbon-group')
    .first()
    .locator('button')
    .allTextContents();
  await dlg.getByRole('button', { name: 'Move Watchlist up' }).click();
  const analysisAfter = await page
    .locator('.ribbon-group')
    .first()
    .locator('button')
    .allTextContents();
  expect(analysisAfter[0]).toContain('Watchlist');
  expect(analysisAfter).not.toEqual(analysisBefore);

  await dlg.getByRole('checkbox', { name: 'Heatmap' }).uncheck();
  await expect(page.getByTestId('ribbon-heatmap')).toHaveCount(0);

  // Reset restores defaults (order + visibility), and that persists too.
  await page.getByTestId('ribbon-reset').click();
  await expect(page.getByTestId('ribbon-heatmap')).toBeVisible();
  const analysisReset = await page
    .locator('.ribbon-group')
    .first()
    .locator('button')
    .allTextContents();
  expect(analysisReset).toEqual(analysisBefore);
  await page.getByRole('button', { name: 'Done' }).click();
  await logoutLogin(page, 'uikit1');
  await expect(page.getByTestId('ribbon-watchlist')).toBeVisible();
  await expect(page.getByTestId('ribbon-heatmap')).toBeVisible();
  expect(errors).toEqual([]);
});

test('ui gallery shows the new P02 components', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?gallery');
  await expect(page.getByRole('heading', { name: 'UI Gallery' })).toBeVisible();

  // Combobox keyboard navigation.
  const combo = page.getByRole('combobox', { name: 'Instrument' });
  await combo.click();
  await combo.fill('nq');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(combo).toHaveValue(/NQ/);

  // Table: sort + select.
  const grid = page.getByRole('grid', { name: 'Demo table' });
  await grid.getByRole('button', { name: 'Price' }).click();
  await grid.getByRole('row').nth(1).click();
  await expect(grid.locator('[aria-selected=true]')).toHaveCount(1);

  // Tree: expand with the keyboard.
  const tree = page.getByRole('tree', { name: 'Demo tree' });
  await tree.getByRole('treeitem').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem').first()).toHaveAttribute('aria-expanded', 'true');

  // Sheet.
  await page.getByRole('button', { name: 'Open sheet' }).click();
  await expect(page.getByRole('dialog', { name: 'Sheet title' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Colour picker: opacity + hex.
  await page.getByRole('button', { name: 'Fill colour' }).click();
  await page.getByLabel('Hex colour').fill('#112233');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Fill colour' })).toContainText('#112233');
  expect(errors).toEqual([]);
});
