import { expect, test } from '@playwright/test';

test('options board: open from the ribbon, add two legs, see payoff and breakevens', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Options Trader');
  await inputs.nth(1).fill('optionstrader');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByTestId('ribbon-options-board').click();
  const board = page.getByTestId('options-board');
  await expect(board.getByText('Options Strategy Analyser')).toBeVisible();
  await expect(board.getByText('Sim', { exact: true })).toBeVisible();
  const firstExpiry = board.getByTestId('options-expiry').first();
  await expect(firstExpiry).toBeVisible();

  // Buy a call and a put at the ask on the first expiry (a long straddle/strangle).
  await firstExpiry.locator('td[data-testid^="ask-"][data-testid$="-C"]').nth(4).click();
  await firstExpiry.locator('td[data-testid^="ask-"][data-testid$="-P"]').nth(4).click();
  await expect(board.getByTestId('strategy-leg')).toHaveCount(2);
  await expect(board.getByTestId('payoff-chart')).toBeVisible();
  await expect(board.getByTestId('breakevens')).toHaveText(/\d.* \/ \d/);
  await expect(board.getByTestId('strategy-stats')).toContainText('Unlimited');

  if (process.env.OB_SHOT) {
    await page.waitForTimeout(4000);
    await page.screenshot({ path: process.env.OB_SHOT });
  }
  await board.getByTestId('send-options').click();
  // Each leg is a paper options position (P18).
  await expect(board.getByTestId('options-position')).toHaveCount(2);
  expect(errors).toEqual([]);
});
