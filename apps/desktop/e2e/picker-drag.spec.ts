import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Drag Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await expect(page.getByTestId('recovery-code').locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function dragCrude(page: Page, ctrl: boolean) {
  await page.getByTestId('instrument-picker').first().click();
  const picker = page.getByTestId('instrument-picker-popover');
  await picker.getByLabel('Search instruments').fill('crude');
  const row = picker.getByRole('option').filter({ hasText: 'Light Sweet Crude' }).first();
  await expect(row).toContainText('Sim');
  const target = page.locator('.dv-groupview').last();
  const tb = (await target.boundingBox())!;
  const rb = (await row.boundingBox())!;
  // Raw mouse: the picker overlaps the dock until the drag starts and it turns see-through.
  await page.mouse.move(rb.x + 150, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + 160, rb.y + rb.height / 2 + 10, { steps: 3 });
  await page.waitForTimeout(100);
  const x = tb.x + tb.width / 2;
  const y = tb.y + tb.height / 2;
  await page.mouse.move(x, y, { steps: 10 });
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.up();
  if (ctrl) await page.keyboard.up('Control');
  await expect(picker).toHaveCount(0);
}

test('drag from the picker: onto a window changes its symbol, Ctrl+drag opens a new chart', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'pickerdrag1');
  const tabs = page.locator('.dv-tab');
  const before = await tabs.count();

  await dragCrude(page, false);
  await expect(page.getByTestId('dock-host')).toContainText('CLZ6');
  await expect(tabs).toHaveCount(before);

  await dragCrude(page, true);
  await expect(tabs).toHaveCount(before + 1);
  expect(errors).toEqual([]);
});
