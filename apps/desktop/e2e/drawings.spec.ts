import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Draw Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('draw a horizontal line and a rectangle; they persist across layout tabs and list in Objects List', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'drawer1');
  const chart = page.getByTestId('chart-footprint');
  const canvas = chart.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1500); // history load
  const overlay = page.getByTestId('drawings-overlay');
  await expect(overlay).toHaveAttribute('data-count', '0');
  const box = (await canvas.boundingBox())!;

  // Horizontal line: one click.
  await page.getByRole('button', { name: 'Lines', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Horizontal Line/ }).click();
  await expect(page.getByRole('button', { name: 'Lines', exact: true })).toHaveAttribute(
    'data-has-tool',
    'true',
  );
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await expect(overlay).toHaveAttribute('data-count', '1');
  await expect(page.getByRole('toolbar', { name: 'Drawing style' })).toBeVisible();

  // Rectangle: F12 hotkey, then drag.
  await page.keyboard.press('F12');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await expect(overlay).toHaveAttribute('data-count', '2');

  // Undo / redo on the focused chart.
  await page.keyboard.press('Control+z');
  await expect(overlay).toHaveAttribute('data-count', '1');
  await page.keyboard.press('Control+y');
  await expect(overlay).toHaveAttribute('data-count', '2');

  // Switch to a new layout tab and back: drawings are restored from the workspace.
  await page.getByRole('button', { name: 'Add layout' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab').first().click();
  await expect(page.getByTestId('drawings-overlay').first()).toHaveAttribute('data-count', '2');

  // Objects List shows both and can delete one.
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Objects List' }).click();
  const list = page.getByTestId('objects-list');
  await expect(list.getByText(/^Horizontal Line/)).toBeVisible();
  await expect(list.getByText('Rectangle')).toBeVisible();
  await list.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await expect(list.locator('tbody tr')).toHaveCount(1);
  expect(errors).toEqual([]);
});
