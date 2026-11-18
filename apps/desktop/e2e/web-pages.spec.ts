import { expect, test } from '@playwright/test';

test('Web Pages (web build): iframe browser, allow-list, bookmarks, palette commands', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://example.com/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<h1>Example page</h1>' }),
  );
  await page.route('https://other.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<h1>Other page</h1>' }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Web Tester');
  await inputs.nth(1).fill('webtester1');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();

  // Registered in the command palette.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('Web Pages:');
  for (const label of [
    'Web Pages: Open browser panel',
    'Web Pages: Reload page',
    'Web Pages: Edit allowed sites',
    'Web Pages: Open this page in the system browser',
  ])
    await expect(palette.getByRole('option', { name: new RegExp(label) })).toBeVisible();
  await palette.getByRole('option', { name: /Web Pages: Open browser panel/ }).click();

  const win = page.getByTestId('web-pages');
  await expect(win).toBeVisible();
  const address = win.getByLabel('Address');

  // Bad schemes are refused with no frame.
  await address.fill('javascript:alert(1)');
  await address.press('Enter');
  await expect(win.getByTestId('web-frame')).toHaveCount(0);

  // A normal address loads in the iframe (web build).
  await address.fill('example.com');
  await address.press('Enter');
  const frame = win.getByTestId('web-frame');
  await expect(frame).toHaveAttribute('src', 'https://example.com/');
  await expect(
    page.frameLocator('[data-testid="web-frame"]').getByText('Example page'),
  ).toBeVisible();

  // Allow-list: only example.com; other sites are refused, subdomains of it are allowed.
  await win.getByRole('button', { name: 'Panel settings' }).click();
  await win.getByLabel('Allowed sites').fill('example.com\nnot a host');
  await win.getByRole('button', { name: 'Save allow-list' }).click();
  await address.fill('other.test');
  await address.press('Enter');
  await expect(frame).toHaveAttribute('src', 'https://example.com/');
  await expect(page.getByText('not in this panel’s allow-list')).toBeVisible();
  await address.fill('docs.example.com');
  await address.press('Enter');
  await expect(frame).toHaveAttribute('src', 'https://docs.example.com/');

  // Bookmarks persist and navigate.
  await win.getByRole('button', { name: 'Add bookmark' }).click();
  await expect(
    win.getByLabel('Bookmarks').getByRole('button', { name: 'docs.example.com', exact: true }),
  ).toBeVisible();
  await win.getByRole('button', { name: 'Back' }).click();
  await expect(frame).toHaveAttribute('src', 'https://example.com/');
  await win
    .getByLabel('Bookmarks')
    .getByRole('button', { name: 'docs.example.com', exact: true })
    .click();
  await expect(frame).toHaveAttribute('src', 'https://docs.example.com/');

  expect(errors).toEqual([]);
});
