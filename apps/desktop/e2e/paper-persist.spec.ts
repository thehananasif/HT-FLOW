import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Passw0rd';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Persist Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill(PASSWORD);
  await inputs.nth(4).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500); // history load
}

/** Brings the footprint chart tab to the front and makes it the active window. */
async function focusChart(page: Page) {
  const tab = page.getByText(/ Footprint$/).first();
  if (await tab.isVisible().catch(() => false)) await tab.click();
  await page.getByTestId('chart-footprint').click({ position: { x: 5, y: 5 } });
}

async function placeLimit(page: Page, side: 'buy' | 'sell', ticks: number) {
  const entry = page.getByTestId('order-entry');
  await entry.getByRole('button', { name: 'Last' }).click();
  const limit = entry.getByLabel('Limit price');
  await limit.click();
  for (let i = 0; i < ticks; i++) await limit.press(side === 'buy' ? 'ArrowDown' : 'ArrowUp');
  await entry.getByTestId(side === 'buy' ? 'place-buy' : 'place-sell').click();
}

test('OCO from the Trading Panel, then positions, orders and options survive a restart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'persist1');
  await page.getByTestId('chart-footprint').click({ position: { x: 5, y: 5 } });
  const panel = page.getByTestId('trading-panel');

  // OCO: a resting buy below and a sell above the market form one group.
  await panel.getByText('OCO', { exact: true }).click();
  await expect(panel.getByTestId('oco-status')).toContainText('the next resting order starts');
  await placeLimit(page, 'buy', 20);
  await placeLimit(page, 'sell', 20);
  const rows = panel.getByTestId('tp-order');
  await expect(rows).toHaveCount(2);
  await expect(panel.getByTestId('tp-oco-badge')).toHaveCount(2);
  await expect(panel.getByTestId('oco-status')).toContainText('OCO group: 2 working');

  // Orders table shows the shared group; cancelling one cancels the other.
  await page.getByTestId('ribbon-orders').click();
  const ordersTable = page.getByTestId('orders-table');
  await expect(ordersTable.locator('[title^="OCO group"]')).toHaveCount(2);
  const cancel = ordersTable.getByRole('button', { name: 'Cancel order' });
  await expect(cancel).toHaveCount(2);
  await cancel.first().click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Cancel order' });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(cancel).toHaveCount(0);

  // Back to the chart and the Trading Panel.
  await focusChart(page);
  await expect(rows).toHaveCount(0);

  // Open state to save: a long position and a working order (OCO off).
  await panel.getByText('OCO', { exact: true }).click();
  await panel.getByTestId('buy-market').click();
  await expect(panel.getByTestId('position-qty')).toHaveText('1');
  await placeLimit(page, 'buy', 30);
  await expect(rows).toHaveCount(1);
  const orderPx = await rows.first().getAttribute('data-px');

  // Options: quick-trade a call at the ask on the Options Board.
  await page.getByTestId('ribbon-options-board').click();
  const board = page.getByTestId('options-board');
  await board.getByLabel('Click a quote').selectOption('trade');
  const firstExpiry = board.getByTestId('options-expiry').first();
  await firstExpiry.locator('td[data-testid^="ask-"][data-testid$="-C"]').nth(4).click();
  await board.getByRole('tab', { name: /Options positions/ }).click();
  await expect(board.getByTestId('options-position')).toHaveCount(1);
  await expect(board.getByTestId('options-position')).toContainText('Debit');
  await expect(board.getByTestId('options-position-pnl')).toContainText(/\d/);

  // The option is in the Positions table next to the futures position.
  await page.getByTestId('ribbon-positions').click();
  const positions = page.getByTestId('positions-table');
  await expect(positions.getByText('OPT', { exact: true })).toBeVisible();

  // Restart: reload the app and log in again.
  await page.waitForTimeout(1000); // debounced profile save
  await page.reload();
  await page.getByLabel('Username').fill('persist1');
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500);
  await focusChart(page);
  const panel2 = page.getByTestId('trading-panel');
  await expect(panel2.getByTestId('position-qty')).toHaveText('1');
  await expect(panel2.getByTestId('tp-order')).toHaveCount(1);
  await expect(panel2.getByTestId('tp-order').first()).toHaveAttribute('data-px', orderPx!);

  await page.getByTestId('ribbon-options-board').click();
  const board2 = page.getByTestId('options-board');
  await board2.getByRole('tab', { name: /Options positions/ }).click();
  await expect(board2.getByTestId('options-position')).toHaveCount(1);
  // Analyse loads the position into the strategy builder; Close books it at the model mark.
  await board2.getByRole('button', { name: 'Analyse' }).click();
  await expect(board2.getByTestId('strategy-leg')).toHaveCount(1);
  await board2.getByRole('tab', { name: /Options positions/ }).click();
  await board2.getByTestId('close-option').click();
  await expect(board2.getByTestId('options-position')).toHaveCount(0);
  expect(errors).toEqual([]);
});
