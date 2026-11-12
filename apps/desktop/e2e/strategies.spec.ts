import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Strategy Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('backtest an example strategy on simulated data: summary, trades, optimiser, journal', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'strat1');
  await page.getByTestId('ribbon-strategies').click();
  const win = page.getByTestId('strategies-window');
  await expect(win).toBeVisible();
  await page.getByTestId('strategy-stacked-imbalance').click();
  // Four hours of simulated ESZ6 history, tape fills (no depth needed), 1-minute bars.
  await win.getByLabel('Hours').fill('4');
  await win.getByLabel('Hours').press('Enter');
  await win.getByLabel('Bars').selectOption('t60000');
  await win.getByLabel('Fill model').selectOption('tape');
  await page.getByTestId('strategy-run').click();
  await expect(page.getByTestId('strategy-summary')).toBeVisible({ timeout: 45_000 });
  const count = Number(await page.getByTestId('strategy-trades-count').textContent());
  expect(count).toBeGreaterThan(0);
  await expect(page.getByTestId('strategy-net')).toContainText('$');

  await win.getByRole('tab', { name: /Trades/ }).click();
  await expect(page.getByTestId('strategy-trades').getByRole('row').nth(1)).toBeVisible();

  await win.getByRole('tab', { name: 'Equity' }).click();
  await expect(page.getByTestId('strategy-equity')).toBeVisible();

  await page.getByTestId('strategy-journal').click();
  await expect(page.getByTestId('strategy-journal')).toHaveText('Sent to Journal');

  // Optimiser: two parameters → heatmap.
  await win.getByRole('tab', { name: 'Optimise' }).click();
  await page.getByTestId('strategy-optimise-run').click();
  await expect(page.getByTestId('strategy-heatmap')).toBeVisible({ timeout: 45_000 });

  // VPS runner is blocked: the UI says so.
  await win.getByRole('tab', { name: 'VPS runner' }).click();
  await expect(page.getByTestId('vps-banner')).toContainText('Requires your own VPS runner');
  expect(errors).toEqual([]);
});

test('attach a strategy to a chart and run it live on paper', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'strat2');
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500);
  const chip = page.getByTestId('strategy-chip').first();
  await chip.click();
  const dialog = page.getByTestId('chart-strategy-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Strategy').selectOption('delta-divergence');
  await expect(page.getByTestId('chart-strategy-summary')).toContainText('trades');
  await page.getByTestId('chart-strategy-live').click();
  await expect(chip).toHaveAttribute('data-status', 'live');
  await page.getByTestId('chart-strategy-live').click();
  await expect(chip).toHaveAttribute('data-status', 'backtest');
  expect(errors).toEqual([]);
});
