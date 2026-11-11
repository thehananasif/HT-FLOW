import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Journal Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500); // history load
}

test('paper round trips show up in the Journal stats, tables and activity', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'journal1');
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('buy-market').click();
    await expect(page.getByTestId('position-qty')).toHaveText('1');
    await page.getByTestId('close-position').click();
    await expect(page.getByTestId('position-qty')).toHaveText('0');
  }
  await page.getByTestId('ribbon-journal').click();
  await expect(page.getByTestId('journal-window')).toBeVisible();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByTestId('journal-trades')).toContainText('2');
  await expect(page.getByTestId('journal-row')).toHaveCount(2);
  await expect(page.getByTestId('journal-detail')).toBeVisible();

  await page.getByTestId('ribbon-trades').click();
  await expect(page.getByTestId('trades-table').getByRole('row')).toHaveCount(5); // header + 4 fills
  await page.getByTestId('ribbon-activity').click();
  await expect(page.getByTestId('activity-table')).toContainText('Fill');
  expect(errors).toEqual([]);
});

test('a tiny daily loss limit locks the account', async ({ page }) => {
  await createAccount(page, 'risk1');
  await page.getByTestId('ribbon-risk').click();
  await expect(page.getByTestId('risk-window')).toBeVisible();
  await page.getByTestId('risk-value-dailyLossLimit').fill('0.01');
  await page.getByTestId('risk-save').click();
  // The rules live in the risk engine, not the window: go back to a trading layout.
  await page.getByRole('button', { name: /DOM \| Chart/ }).click();
  await expect(page.getByTestId('dom-ladder')).toBeVisible();
  await page.getByTestId('chart-footprint').click({ position: { x: 5, y: 5 } });
  const meter = page.getByTestId('risk-meter');
  // Taking a position and closing it at the bid (spread + any move) loses more than $0.01,
  // which must flatten and lock the account.
  for (let i = 0; i < 5; i++) {
    const buy = page.getByTestId('buy-market');
    if (await buy.isEnabled()) await buy.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    if ((await meter.getAttribute('data-state')) === 'locked') break;
    const close = page.getByTestId('close-position');
    // The lock can land at any moment; a disabled button means it already has.
    if (await close.isEnabled()) await close.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    if ((await meter.getAttribute('data-state')) === 'locked') break;
  }
  await expect(meter).toHaveAttribute('data-state', 'locked', { timeout: 10_000 });
  await expect(page.getByTestId('position-qty')).toHaveText('0');
  await expect(page.getByTestId('buy-market')).toBeDisabled();
  await page.getByTestId('ribbon-risk').click();
  await expect(page.getByTestId('risk-usage').last()).toHaveText('Locked');
  await expect(page.getByTestId('risk-locked').last()).toBeVisible();
});
