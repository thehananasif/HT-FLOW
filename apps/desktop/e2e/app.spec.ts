import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Test Trader');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  const code = page.getByTestId('recovery-code');
  await expect(code.locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('create account → dashboard with DOM, footprint and trading panel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'trader1');
  await expect(page.getByTestId('dom-ladder')).toBeVisible();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await expect(page.getByTestId('sidetools')).toBeVisible();
  expect(errors).toEqual([]);
});

test('layout presets open the four core charts', async ({ page }) => {
  await createAccount(page, 'trader2');
  await page.getByRole('button', { name: /Grid 2×2/ }).click();
  for (const id of ['candles-vp', 'footprint', 'liquidity-map', 'order-flow-dark']) {
    await expect(page.getByTestId(`chart-${id}`)).toBeVisible();
  }
  await page.getByRole('button', { name: /Single/ }).click();
  await expect(page.getByTestId('chart-footprint')).toHaveCount(1);
  await page.getByRole('button', { name: 'Liquidity Map' }).first().click();
  await expect(page.getByTestId('chart-liquidity-map')).toBeVisible();
});

test('paper trading: market buy, position, close', async ({ page }) => {
  await createAccount(page, 'trader3');
  await page.waitForTimeout(1500); // history load
  await page.getByTestId('buy-market').click();
  await expect(page.getByTestId('position-qty')).toHaveText('1');
  await page.getByTestId('close-position').click();
  await expect(page.getByTestId('position-qty')).toHaveText('0');
});

test('footprint modes switch from side tools and command palette lists commands', async ({
  page,
}) => {
  await createAccount(page, 'trader4');
  await page.getByRole('button', { name: 'Bid x Ask ›' }).click();
  await page.getByRole('menuitemradio', { name: 'Bid x Ask Ladder' }).click();
  await expect(page.getByRole('button', { name: 'Bid x Ask ›' })).toHaveAttribute(
    'data-active',
    'true',
  );
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search commands, symbols, layouts…').fill('grid');
  await expect(page.getByRole('option', { name: /Layout: Grid 2×2/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chart-order-flow-dark')).toBeVisible();
});

test('wrong password is rejected; correct password logs in', async ({ page }) => {
  await createAccount(page, 'trader5');
  await page.getByTestId('account-menu').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.getByLabel('Username').fill('trader5');
  await page.locator('input[type=password]').fill('wrong-password!!');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Wrong password')).toBeVisible();
  await page.locator('input[type=password]').fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
});
