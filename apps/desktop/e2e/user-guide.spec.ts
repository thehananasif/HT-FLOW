import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Guide Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('User Guide: search "footprint", open the section, image loads; F1, Help menu, panel help', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'guide1');

  // F1 opens the guide.
  await page.keyboard.press('F1');
  const win = page.getByTestId('user-guide');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('guide-article')).toContainText('Getting started');

  // Search → section hit → article with an image that really loads.
  await win.getByLabel('Search the guide').fill('footprint');
  const hit = win.getByTestId('guide-hit').filter({ hasText: 'Order flow tools' }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  const article = win.getByTestId('guide-article');
  await expect(article).toContainText('Order flow tools');
  const img = article.getByTestId('guide-image').first();
  await img.scrollIntoViewIfNeeded();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);

  // Previous / next navigation.
  await article.getByRole('button', { name: /Trading →$/ }).click();
  await expect(article.getByRole('heading', { name: 'Trading', level: 2 })).toBeVisible();

  // Keyboard shortcuts article renders the live command table.
  await win.getByLabel('Search the guide').fill('shortcuts');
  await win.getByTestId('guide-hit').first().click();
  await expect(win.getByTestId('guide-shortcuts')).toContainText('Command palette');

  // "New" marker on the AI page.
  await win.getByLabel('Search the guide').fill('');
  await expect(win.locator('.ug-item', { hasText: 'AI page' }).locator('.ug-new')).toBeVisible();

  // Help menu → User Guide; palette entry; panel help from a chart header.
  await page.getByTestId('help-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Help for this window' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/search commands/i).fill('Open User Guide');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }).getByRole('option').first(),
  ).toContainText('User Guide');
  await page.keyboard.press('Escape');

  await page
    .getByTestId('win-hdr-dom-1')
    .getByRole('button', { name: 'Help for this panel' })
    .click();
  await expect(win.getByRole('heading', { name: 'Smart DOM', level: 3 })).toBeVisible();
  expect(errors).toEqual([]);
});
