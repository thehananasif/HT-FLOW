import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Leftover Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('double-clicked .htstrat file opens in the HT Editor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'leftover1');

  const text = JSON.stringify({
    format: 'htstrat',
    version: 1,
    id: 'stg-from-disk',
    name: 'Opened from disk',
    files: [{ name: 'strategy.ts', source: '// opened from disk\nexport function onBar() {}\n' }],
    params: {},
    createdAt: 1,
    updatedAt: 1,
  });
  await page.evaluate((t) => {
    window.dispatchEvent(
      new CustomEvent('htflow:inject-file', {
        detail: {
          path: 'C:\\x\\disk.htstrat',
          name: 'disk.htstrat',
          ext: 'htstrat',
          kind: 'strategy',
          text: t,
          error: null,
        },
      }),
    );
  }, text);

  const ed = page.getByTestId('ht-editor');
  await expect(ed).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ht-editor-code')).toContainText('opened from disk');
  await expect(page.getByText('Opened Opened from disk in HT Editor')).toBeVisible();
  expect(errors).toEqual([]);
});
