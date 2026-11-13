import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Alerts Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500); // history load
}

const openModule = (page: Page, id: string) =>
  page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('htflow:open-module', { detail })),
    id,
  );

test('funding / liquidation alerts, flash + sound actions, test run, Telegram / Discord delivery', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'alerts23');
  await openModule(page, 'alerts');
  const win = page.getByTestId('alerts-window').last();
  await expect(win).toBeVisible();
  const form = win.getByTestId('alert-form');

  // Funding rate alert with "Flash window".
  await form.getByLabel('Condition type').selectOption('funding');
  await expect(form).toContainText('Needs a live derivatives connection');
  await form.getByTestId('alert-value').fill('0.05');
  await form.getByTestId('alert-action-flash').click();
  await expect(form.getByTestId('alert-action-flash')).toHaveAttribute('aria-pressed', 'true');
  await form.getByTestId('alert-sound').selectOption('alarm');
  await form.getByTestId('alert-create').click();
  const funding = win.locator('[data-testid="alert-row"][data-kind="funding"]');
  await expect(funding).toHaveCount(1);
  await expect(funding).toContainText('|rate| ≥ 0.05%');
  await expect(funding).toContainText('Flash window');

  // Liquidation alert over a rolling window.
  await form.getByLabel('Condition type').selectOption('liquidation');
  await form.getByLabel('Side').selectOption('buy');
  await form.getByTestId('alert-value').fill('100');
  await form.getByLabel('Liquidation window').selectOption('300000');
  await form.getByTestId('alert-create').click();
  const liq = win.locator('[data-testid="alert-row"][data-kind="liquidation"]');
  await expect(liq).toContainText('long liquidations ≥ 100 in 5 min');

  // "Test" runs the actions now: toast + flashing title.
  await funding.getByRole('button', { name: 'Test alert' }).click();
  await expect(page.getByText(/Alert: .*funding/).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-alert-flash', '1');

  // Delivery settings: validated, stored in the vault.
  await form.getByRole('button', { name: /Delivery: Telegram/ }).click();
  const delivery = form.getByTestId('alert-delivery');
  await delivery.getByLabel('Discord webhook URL').fill('https://example.com/hook');
  await expect(delivery).toContainText('Discord webhook must be');
  await expect(delivery.getByTestId('delivery-save')).toBeDisabled();
  await delivery
    .getByLabel('Discord webhook URL')
    .fill('https://discord.com/api/webhooks/123456789/abcDEF_token-1');
  await delivery
    .getByLabel('Telegram bot token')
    .fill('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  await delivery.getByLabel('Telegram chat id').fill('-1001234567890');
  await delivery.getByTestId('delivery-save').click();
  await expect(page.getByText('Delivery settings saved')).toBeVisible();
  // Re-opened panel reads the saved values back from the vault.
  await form.getByRole('button', { name: /Delivery: Telegram/ }).click();
  await form.getByRole('button', { name: /Delivery: Telegram/ }).click();
  await expect(delivery.getByLabel('Telegram chat id')).toHaveValue('-1001234567890');

  // Telegram / Discord action chips exist on new alerts.
  await expect(form.getByTestId('alert-action-telegram')).toBeVisible();
  await expect(form.getByTestId('alert-action-discord')).toBeVisible();
  expect(errors).toEqual([]);
});

test('drawing "Alert on cross" shows up in the Alerts window; deleting it there clears the flag', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'alerts23d');
  const canvas = page.getByTestId('chart-footprint').locator('canvas').first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.keyboard.press('F6');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await expect(page.getByTestId('drawings-overlay')).toHaveAttribute('data-count', '1');
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
  const bell = page.getByRole('button', { name: 'Alert on cross' });
  await bell.click();
  await expect(bell).toHaveAttribute('aria-pressed', 'true');

  await openModule(page, 'alerts');
  const win = page.getByTestId('alerts-window').last();
  const row = win.locator('[data-testid="alert-row"][data-kind="drawing"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('(drawing)');
  await row.getByRole('button', { name: 'Delete alert' }).click();
  await expect(row).toHaveCount(0);
  // The drawing's flag was cleared, so the alert is not re-created.
  await page.waitForTimeout(500);
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('risk rules apply to all paper accounts; news feed comes from the Economic Calendar', async ({
  page,
}) => {
  await createAccount(page, 'risk23');
  await page.getByTestId('ribbon-risk').click();
  const risk = page.getByTestId('risk-window').last();
  await expect(risk).toBeVisible();
  await expect(risk.getByTestId('risk-news-feed')).toContainText('News feed: Economic Calendar');
  // SAMPLE calendar events count only when asked.
  await expect(risk.getByTestId('risk-news-feed')).toContainText('0 high-impact');
  await risk.getByTestId('risk-news-sample').check();
  await expect(risk.getByTestId('risk-news-feed')).not.toContainText(' 0 high-impact');
  await risk.getByTestId('risk-value-dailyLossLimit').fill('1234');
  await risk.getByTestId('risk-apply-all').check();
  await risk.getByTestId('risk-save').click();
  await expect(page.getByText(/All \d+ paper accounts/)).toBeVisible();
});
