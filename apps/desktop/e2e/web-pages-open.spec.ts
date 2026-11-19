import { expect, test } from '@playwright/test';

test('Web Pages opens from the ribbon, and a refused-framing hint offers the system browser', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A site that forbids framing (X-Frame-Options), like many real sites.
  await page.route('https://blocked.test/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      headers: { 'x-frame-options': 'DENY' },
      body: '<h1>No frames</h1>',
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Web Open');
  await inputs.nth(1).fill('webopen1');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();

  await page
    .getByRole('button', { name: /^Web Pages/ })
    .first()
    .click();
  const win = page.getByTestId('web-pages');
  await expect(win).toBeVisible();
  await expect(win.getByLabel('Address')).toBeVisible();

  const address = win.getByLabel('Address');
  await address.fill('blocked.test');
  await address.press('Enter');
  const hint = win.getByTestId('web-frame-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(/forbid|refuse|blank/i);
  await expect(hint.getByRole('button', { name: 'Open in system browser' })).toBeVisible();
  expect(errors).toEqual([]);
});
