import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Misc Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

async function palette(page: Page, query: string) {
  await page.keyboard.press('Control+k');
  await page
    .getByPlaceholder(/search|type/i)
    .first()
    .fill(query);
  await page.keyboard.press('Enter');
}

test('Web Pages: tabs, address bar, bookmarks, and claiming open-url links', async ({ page }) => {
  await createAccount(page, 'misc1');
  await page.getByTestId('ribbon-web-pages').click();
  const win = page.getByTestId('web-pages');
  await expect(win).toBeVisible();

  await win.getByLabel('Address').fill('example.com/one');
  await win.getByLabel('Address').press('Enter');
  await expect(win.getByTestId('web-frame')).toHaveAttribute('src', 'https://example.com/one');
  await expect(win.getByRole('button', { name: 'Back' })).toBeDisabled();

  await win.getByLabel('Address').fill('example.com/two');
  await win.getByLabel('Address').press('Enter');
  await win.getByRole('button', { name: 'Back' }).click();
  await expect(win.getByLabel('Address')).toHaveValue('https://example.com/one');
  await win.getByRole('button', { name: 'Forward' }).click();
  await expect(win.getByLabel('Address')).toHaveValue('https://example.com/two');

  await win.getByRole('button', { name: 'Add bookmark' }).click();
  await expect(win.getByRole('button', { name: 'Remove bookmark', exact: true })).toBeVisible();
  await expect(win.getByLabel('Bookmarks')).toContainText('example.com');

  // Another window (RSS / News) hands a link over via the cancelable event.
  const claimed = await page.evaluate(() => {
    const ev = new CustomEvent('htflow:open-url', {
      detail: 'https://example.org/story',
      cancelable: true,
    });
    return !window.dispatchEvent(ev);
  });
  expect(claimed).toBe(true);
  await expect(win.getByLabel('Address')).toHaveValue('https://example.org/story');
  await expect(win.getByRole('tab')).toHaveCount(2);

  // Non-web schemes are never claimed.
  const bad = await page.evaluate(() => {
    const ev = new CustomEvent('htflow:open-url', {
      detail: 'javascript:alert(1)',
      cancelable: true,
    });
    return window.dispatchEvent(ev);
  });
  expect(bad).toBe(true);
});

test('Logs: captures errors, filters, pauses and clears', async ({ page }) => {
  await createAccount(page, 'misc2');
  await page.getByTestId('ribbon-logs').click();
  const win = page.getByTestId('logs-window');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('logs-body')).toContainText('HT Flow started');

  await page.evaluate(() => console.error('e2e-boom-marker', { code: 7 }));
  await expect(win.getByTestId('logs-body')).toContainText('e2e-boom-marker');
  await expect(win.getByTestId('logs-body')).toContainText('[console]');

  // Unhandled rejections are captured too.
  await page.evaluate(() => {
    void Promise.reject(new Error('e2e-rejection-marker'));
  });
  await expect(win.getByTestId('logs-body')).toContainText('e2e-rejection-marker');

  // Level filter hides info lines; search narrows.
  await win.getByLabel('Minimum level').selectOption('error');
  await expect(win.getByTestId('logs-body')).not.toContainText('HT Flow started');
  await win.getByLabel('Search logs').fill('rejection-marker');
  await expect(win.getByTestId('logs-body')).not.toContainText('e2e-boom-marker');
  await win.getByLabel('Search logs').fill('');

  // Pause freezes the view while recording continues.
  await win.getByRole('button', { name: 'Pause' }).click();
  await page.evaluate(() => console.error('e2e-while-paused'));
  await expect(win.getByTestId('logs-body')).not.toContainText('e2e-while-paused');
  await win.getByRole('button', { name: /^Resume/ }).click();
  await expect(win.getByTestId('logs-body')).toContainText('e2e-while-paused');

  // Export downloads a .txt.
  const dl = page.waitForEvent('download');
  await win.getByRole('button', { name: 'Export .txt' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^htflow-log-.*\.txt$/);

  await win.getByRole('button', { name: 'Clear' }).click();
  await expect(win.getByTestId('logs-body')).toContainText('No log lines match');
});

test('User Guide: search, articles, and Open this window links', async ({ page }) => {
  await createAccount(page, 'misc3');
  await palette(page, 'Open User Guide');
  const win = page.getByTestId('user-guide');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('guide-article')).toContainText('Welcome to HT Flow');

  await win.getByLabel('Search the guide').fill('replay');
  await win
    .getByRole('button', { name: /^Replay/ })
    .first()
    .click();
  await expect(win.getByTestId('guide-article')).toContainText('Load sample replay session');
  await win.getByLabel('Search the guide').fill('shortcuts');
  await win.getByRole('button', { name: /^Keyboard shortcuts/ }).click();
  await expect(win.getByTestId('guide-article')).toContainText('Command palette');
  await win.getByLabel('Search the guide').fill('zzzznotaword');
  await expect(win.getByText('No articles match')).toBeVisible();

  // "Open this window" links open the module in a new window.
  await win.getByLabel('Search the guide').fill('replay');
  await win
    .getByRole('button', { name: /^Replay/ })
    .first()
    .click();
  await win.getByRole('button', { name: 'Open Replay' }).click();
  await expect(page.getByTestId('replay-window')).toBeVisible();
});

test('guided tour: start from the palette, step through, skip', async ({ page }) => {
  await createAccount(page, 'misc5');
  // Automation never auto-starts the tour (it would block clicks in other tests).
  await expect(page.getByTestId('tour')).toHaveCount(0);

  await palette(page, 'Start guided tour');
  const tour = page.getByTestId('tour');
  await expect(tour).toBeVisible();
  await expect(page.getByTestId('tour-title')).toHaveText('Ribbon');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByTestId('tour-title')).toHaveText('Chart');
  await tour.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('tour-title')).toHaveText('Ribbon');

  await tour.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tour).toHaveCount(0);

  // Restart and run to the end with the keyboard.
  await palette(page, 'Start guided tour');
  await expect(tour).toBeVisible();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tour-title')).toHaveText('Status bar');
  await tour.getByRole('button', { name: 'Done' }).click();
  await expect(tour).toHaveCount(0);
});

test('Load sample replay session starts a replay on the chart', async ({ page }) => {
  await createAccount(page, 'misc6');
  await palette(page, 'Load sample replay session');
  await expect(page.getByText('Sample replay ready')).toBeVisible({ timeout: 30_000 });
});
