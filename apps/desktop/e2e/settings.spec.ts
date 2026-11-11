import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Settings Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('settings: token colour + hotkey rebinding, export JSON, new hotkey works', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'settings1');

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  const win = page.getByTestId('settings-window');
  await expect(win).toBeVisible();

  // Appearance: change the "up" market colour.
  await win.getByRole('button', { name: 'Appearance' }).click();
  await win.getByLabel('up colour').fill('#123456');
  await win.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ht-up').trim(),
      ),
    )
    .toBe('#123456');

  // Hot keys: rebind "Toggle Trading Panel" from T to Shift+P.
  await win.getByRole('button', { name: 'Hot keys' }).click();
  await win.getByLabel('Filter commands').fill('Toggle Trading Panel');
  await win.getByLabel('Shortcut for Toggle Trading Panel').click();
  await page.keyboard.press('Shift+P');
  await expect(win.getByLabel('Shortcut for Toggle Trading Panel')).toHaveText('Shift+P');
  await win.getByRole('button', { name: 'Apply', exact: true }).click();

  // Export JSON contains both changes.
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    win.getByTestId('settings-export').click(),
  ]);
  const json = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(json.kind).toBe('htflow-settings');
  expect(json.values['appearance.tokens']).toEqual({ up: '#123456' });
  expect(json.values['hotkeys.bindings']['trading-panel']).toEqual({ shortcut: 'Shift+P' });

  // OK closes the window; the new hotkey toggles the panel, the old one no longer does.
  await win.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(win).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('t');
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.keyboard.press('Shift+P');
  await expect(page.getByTestId('trading-panel')).toHaveCount(0);

  // Persisted per profile: survives logout / login.
  await page.getByTestId('account-menu').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.getByLabel('Username').fill('settings1');
  await page.locator('input[type=password]').fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--ht-up').trim(),
      ),
    )
    .toBe('#123456');
  expect(errors).toEqual([]);
});
