import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Test Trader');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

/** Accessible name of a button: aria-label, aria-labelledby, visible text, title or image alt. */
async function unnamedButtons(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    document.querySelectorAll(`${sel} button, ${sel} [role="button"]`).forEach((b) => {
      const el = b as HTMLElement;
      const name =
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby') ||
        el.textContent?.trim() ||
        el.getAttribute('title') ||
        el.querySelector('img[alt]')?.getAttribute('alt');
      if (!name) out.push(el.outerHTML.slice(0, 120));
    });
    return out;
  }, scope);
}

test('accessibility: every ribbon and title-bar button has an accessible name', async ({
  page,
}) => {
  // Login screen title bar.
  await page.goto('/');
  expect(await unnamedButtons(page, 'header.titlebar')).toEqual([]);
  await createAccount(page, 'a11yuser');
  expect(await unnamedButtons(page, 'header.titlebar')).toEqual([]);
  expect(await unnamedButtons(page, 'nav.ribbon')).toEqual([]);
  // The ribbon is a labelled landmark.
  await expect(page.getByRole('navigation', { name: 'Ribbon' })).toBeVisible();
});

test('Report a problem opens, builds a redacted summary and sends nothing', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost')) requests.push(r.url());
  });
  await createAccount(page, 'reporter');
  await page.keyboard.press('Control+k');
  await page
    .getByPlaceholder(/search|command/i)
    .first()
    .fill('Report a problem');
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('report-problem');
  await expect(dialog).toBeVisible();
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'])
    .catch(() => {});
  await page.getByTestId('report-copy').click();
  await expect(page.getByLabel('Redacted summary')).toContainText('HT Flow problem report');
  // The web build has no crash folder.
  await expect(page.getByTestId('report-open-folder')).toBeDisabled();
  expect(requests).toEqual([]);
});

test('Check for updates says updates are unavailable in the web build', async ({ page }) => {
  await createAccount(page, 'updater');
  await page.keyboard.press('Control+k');
  await page
    .getByPlaceholder(/search|command/i)
    .first()
    .fill('Check for updates');
  await page
    .getByRole('option', { name: /Check for updates/ })
    .first()
    .click();
  const dlg = page.getByTestId('update-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('update-message')).toHaveText('Updates unavailable in this build');
  await expect(dlg).toHaveAttribute('data-phase', 'unavailable');
});
