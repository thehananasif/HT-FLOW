import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Tables Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500);
}

test('ui-kit Table: resize a column, reorder by dragging a header; popover escapes overflow:hidden', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?gallery');
  const grid = page.getByRole('grid', { name: 'Demo table' });
  const heads = grid.getByRole('columnheader');
  await grid.scrollIntoViewIfNeeded();
  await expect(heads.first()).toContainText('Symbol');

  // Resize: drag the Price column edge 40 px to the right.
  const price = heads.nth(1);
  const w0 = (await price.boundingBox())!.width;
  const handle = (await grid.getByTestId('ht-resize-price').boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(handle.x + 23, handle.y + 8, { steps: 4 });
  await page.mouse.move(handle.x + 43, handle.y + 8, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await price.boundingBox())!.width).toBeGreaterThan(w0 + 30);

  // Reorder: drag Symbol over the Chg header.
  const sym = (await heads.nth(0).boundingBox())!;
  const chg = (await heads.nth(2).boundingBox())!;
  await page.mouse.move(sym.x + 20, sym.y + 10);
  await page.mouse.down();
  await page.mouse.move(sym.x + 60, sym.y + 10, { steps: 4 });
  await page.mouse.move(chg.x + chg.width - 10, chg.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(heads.first()).toContainText('Price');
  await expect(heads.last()).toContainText('Symbol');

  // Popover: portal to <body>, wider than its overflow:hidden parent, inside the viewport.
  await page.getByRole('button', { name: 'Popover', exact: true }).click();
  const pop = page.getByTestId('gallery-popover');
  await expect(pop).toBeVisible();
  expect(await pop.evaluate((el) => el.parentElement === document.body)).toBe(true);
  const box = (await pop.boundingBox())!;
  expect(box.width).toBeGreaterThan(150);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Orders table: edit a working order price inline, Enter applies', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'inlinemod');

  const entry = page.getByTestId('order-entry');
  await entry.getByRole('button', { name: 'Last' }).click();
  const limit = entry.getByLabel('Limit price');
  await limit.click();
  for (let i = 0; i < 6; i++) await limit.press('ArrowDown');
  await entry.getByTestId('place-buy').click();

  await page.getByTestId('ribbon-orders').click();
  const cell = page.locator('[data-testid^="order-price-"]').first();
  await expect(cell).toBeVisible();
  const before = parseFloat((await cell.textContent())!);
  expect(before).toBeGreaterThan(0);

  await cell.dblclick();
  const input = page.getByTestId('order-price-input');
  await expect(input).toBeFocused();
  await input.fill(String(before - 5));
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect.poll(async () => parseFloat((await cell.textContent())!)).toBeCloseTo(before - 5, 1);

  // Esc cancels without changing anything.
  await cell.dblclick();
  await page.getByTestId('order-price-input').fill(String(before - 50));
  await page.keyboard.press('Escape');
  await expect(cell).toHaveText(/\d/);
  expect(parseFloat((await cell.textContent())!)).toBeCloseTo(before - 5, 1);
  expect(errors).toEqual([]);
});
