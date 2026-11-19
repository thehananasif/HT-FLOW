import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Editor Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('HT Editor: MA-cross template backtests in the sandbox worker and lists trades', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'hteditor1');
  await page.getByTestId('ribbon-strategies').click();
  const win = page.getByTestId('strategies-window');
  await expect(win).toBeVisible();
  await win.getByRole('tab', { name: 'HT Editor' }).click();
  const ed = page.getByTestId('ht-editor');
  await expect(ed).toBeVisible();

  await ed.getByLabel('Templates').selectOption('ma-cross');
  await expect(page.getByTestId('ht-editor-code')).toContainText('MA cross');
  await expect(ed.getByText('Compiled')).toBeVisible();
  // Params form comes from the sandbox's description of the script.
  await expect(page.getByTestId('hte-params')).toBeVisible({ timeout: 20_000 });

  await ed.getByLabel('Hours').fill('4');
  await ed.getByLabel('Hours').press('Enter');
  await ed.getByLabel('Bars').selectOption('t60000');
  await page.getByTestId('hte-backtest').click();
  await expect(page.getByTestId('strategy-summary')).toBeVisible({ timeout: 60_000 });
  const count = Number(await page.getByTestId('strategy-trades-count').textContent());
  expect(count).toBeGreaterThan(0);

  await ed.getByRole('tab', { name: /Trades/ }).click();
  await expect(page.getByTestId('hte-trades').getByRole('row').nth(1)).toBeVisible();
  await ed.getByRole('tab', { name: 'Log' }).click();
  await expect(page.getByTestId('hte-log')).toContainText('MA cross started');

  // A syntax error shows up as a problem and blocks the backtest.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nconst = 1;');
  await expect(ed.getByText(/1 error/)).toBeVisible();
  await ed.getByRole('tab', { name: /Problems/ }).click();
  await expect(page.getByTestId('hte-problems')).toContainText('Syntax error');

  // Live needs an armed connector that supports live orders: none exists, so it stays disabled.
  await page.getByTestId('hte-live').click();
  await expect(page.getByTestId('hte-no-live')).toBeVisible();
  await expect(page.getByTestId('hte-arm-go')).toBeDisabled();

  expect(errors).toEqual([]);
});
