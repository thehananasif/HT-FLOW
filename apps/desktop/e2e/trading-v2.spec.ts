import { expect, test, type Locator, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Trading Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500); // history load
}

interface Line {
  kind: 'position' | 'order' | 'sl' | 'tp';
  id: string;
  px: number;
  y: number;
  x: number;
  xClose: number;
}

async function lines(probe: Locator): Promise<Line[]> {
  return JSON.parse((await probe.getAttribute('data-lines')) || '[]') as Line[];
}

async function drag(page: Page, canvas: Locator, from: { x: number; y: number }, toY: number) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + from.x, box.y + (from.y + toY) / 2, { steps: 4 });
  await page.mouse.move(box.x + from.x, box.y + toY, { steps: 4 });
  await page.mouse.up();
}

test('limit order with an ATM template: drag to modify on the chart, fill, see position and bracket', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'tradingv2');
  const chart = page.getByTestId('chart-footprint');
  await chart.click({ position: { x: 5, y: 5 } });
  const canvas = chart.locator('canvas').first();
  const probe = chart.getByTestId('chart-trading');

  // ATM template + SL/TP on.
  const panel = page.getByTestId('trading-panel');
  await panel.getByLabel('ATM template', { exact: true }).selectOption({ label: 'ATM · Three targets + BE' });
  await expect(page.getByTestId('atm-summary')).toContainText('TP 8/16/32T');
  await page.getByRole('switch', { name: 'SL/TP bracket' }).click();

  // Buy limit 6 ticks under the last trade.
  const entry = page.getByTestId('order-entry');
  await entry.getByRole('button', { name: 'Last' }).click();
  const limit = entry.getByLabel('Limit price');
  await limit.click();
  for (let i = 0; i < 6; i++) await limit.press('ArrowDown');
  await entry.getByTestId('place-buy').click();

  const row = page.getByTestId('tp-order');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('BUY LMT 1');
  await expect(row).toContainText('Three targets + BE');
  const placedPx = Number(await row.getAttribute('data-px'));

  // The working order line is on the chart.
  await expect.poll(async () => (await lines(probe)).filter((l) => l.kind === 'order').length).toBe(1);
  let order = (await lines(probe)).find((l) => l.kind === 'order')!;
  expect(order.px).toBe(placedPx);

  // Drag it 40 px down → lower price, still working.
  await drag(page, canvas, order, order.y + 40);
  await expect.poll(async () => Number(await row.getAttribute('data-px'))).toBeLessThan(placedPx);
  await expect(row).toHaveCount(1);
  order = (await lines(probe)).find((l) => l.kind === 'order')!;
  expect(order.px).toBeLessThan(placedPx);

  // Drag it well above the market → marketable → fills.
  const lastY = Number(await probe.getAttribute('data-last-y'));
  const top = Number(await probe.getAttribute('data-plot-top'));
  await drag(page, canvas, order, Math.max(top + 4, lastY - 60));
  await expect(page.getByTestId('position-qty')).toHaveText('1');

  // Position line + bracket (SL and the target that got the lot) on the chart.
  await expect
    .poll(async () => (await lines(probe)).map((l) => l.kind).sort())
    .toEqual(expect.arrayContaining(['position', 'sl', 'tp']));
  const after = await lines(probe);
  const pos = after.find((l) => l.kind === 'position')!;
  const sl = after.find((l) => l.kind === 'sl')!;
  const tp = after.find((l) => l.kind === 'tp')!;
  expect(sl.px).toBeLessThan(pos.px);
  expect(tp.px).toBeGreaterThan(pos.px);
  await expect(probe).toContainText('LONG 1 @');
  await expect(page.getByTestId('tp-order').filter({ hasText: 'SL STP' })).toHaveCount(1);

  // Drag the stop-loss bracket line up by 10 px: it moves closer to the entry.
  await drag(page, canvas, sl, sl.y - 10);
  await expect
    .poll(async () => (await lines(probe)).find((l) => l.kind === 'sl')?.px ?? 0)
    .toBeGreaterThan(sl.px);

  // ✕ on the position line closes the position.
  const posNow = (await lines(probe)).find((l) => l.kind === 'position')!;
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + posNow.xClose, box.y + posNow.y);
  await expect(page.getByTestId('position-qty')).toHaveText('0');
  await expect.poll(async () => (await lines(probe)).length).toBe(0);
  expect(errors).toEqual([]);
});

test('paper accounts: create, switch, balance shown; confirmations ask before sending', async ({
  page,
}) => {
  await createAccount(page, 'tradingv2b');
  await page.getByTestId('chart-footprint').click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Manage paper accounts' }).click();
  const setup = page.getByTestId('trading-setup');
  await expect(setup).toBeVisible();
  await setup.getByLabel('New account name').fill('Swing');
  await setup.getByLabel('New starting balance').fill('25000');
  await setup.getByLabel('New starting balance').press('Tab');
  await setup.getByTestId('create-paper-account').click();
  await expect(setup.getByTestId('paper-account')).toHaveCount(2);
  await setup.getByTestId('paper-account').nth(1).getByRole('button', { name: 'Use' }).click();
  await expect(page.getByTestId('account-balance')).toContainText('25,000.00 USD');

  // Order confirmations for market orders.
  await setup.getByRole('tab', { name: 'Order confirmations' }).click();
  await setup.getByText('Market orders').click();
  // The setup window took focus; make the DOM window active again (mouse down inside it).
  await page.getByTestId('dom-atm').first().dispatchEvent('mousedown');
  await page.getByTestId('buy-market').click();
  await expect(page.getByTestId('order-confirm')).toBeVisible();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('position-qty')).toHaveText('1');
});
