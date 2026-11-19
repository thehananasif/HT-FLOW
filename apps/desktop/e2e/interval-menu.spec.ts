import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Interval Menu');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

const tfButton = (page: Page) => page.getByRole('button', { name: 'Timeframe' }).first();

test('timeframe menu: pick 4 hours, add a custom 7 minutes, favourite it, quick input', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'intervalmenu1');
  await expect(page.getByTestId('chart-footprint').locator('canvas').first()).toBeVisible();

  await tfButton(page).click();
  const menu = page.getByTestId('interval-menu');
  await expect(menu.getByRole('menuitem', { name: '45 seconds' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '12 months' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '1000 ticks' })).toBeVisible();

  // collapse a group, it stays collapsed after reopening
  await menu.getByRole('button', { name: 'Seconds', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: '45 seconds' })).toBeHidden();

  await menu.getByRole('menuitem', { name: '4 hours' }).click();
  await expect(
    page.locator('.win-hdr .ht-chip[aria-pressed="true"]', { hasText: 'H4' }),
  ).toBeVisible();

  await tfButton(page).click();
  await expect(menu.getByRole('menuitem', { name: '45 seconds' })).toBeHidden();
  await menu.getByRole('menuitem', { name: 'Add custom interval…' }).click();
  const dlg = page.getByTestId('custom-interval-dialog');
  await dlg.getByLabel('Value').fill('0');
  await expect(dlg.getByRole('alert')).toBeVisible();
  await expect(dlg.getByTestId('custom-add')).toBeDisabled();
  await dlg.getByLabel('Value').fill('7');
  await dlg.getByTestId('custom-add').click();
  await expect(dlg).toBeHidden();
  await expect(
    page.locator('.win-hdr .ht-chip[aria-pressed="true"]', { hasText: 'M7' }),
  ).toBeVisible();

  // favourite it: appears as a toolbar chip even after switching away
  await tfButton(page).click();
  await menu.getByRole('button', { name: 'Add 7 minutes to favourites' }).click();
  await menu.getByRole('menuitem', { name: '4 hours' }).click();
  await expect(page.locator('.win-hdr .ht-chip', { hasText: 'M7' })).toBeVisible();

  // quick input: "15" Enter = 15 minutes
  await page.getByTestId('chart-footprint').click({ position: { x: 200, y: 200 } });
  await page.keyboard.type('15');
  await expect(page.getByTestId('quick-interval')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('.win-hdr .ht-chip[aria-pressed="true"]', { hasText: 'M15' }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});
