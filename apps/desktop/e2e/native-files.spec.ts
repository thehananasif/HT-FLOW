import { expect, test, type Page } from '@playwright/test';

// The native calls (log folder, backups, start-up prefs) are mocked by `__HTFLOW_NATIVE_MOCK__`,
// which records every call in `window.__HTFLOW_NATIVE_CALLS__`.
async function createAccount(page: Page, username: string) {
  await page.addInitScript(() => {
    (window as unknown as { __HTFLOW_NATIVE_MOCK__: boolean }).__HTFLOW_NATIVE_MOCK__ = true;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Native Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

const calls = (page: Page) =>
  page.evaluate(() => (window.__HTFLOW_NATIVE_CALLS__ ?? []).map((c) => c.cmd));

test('settings: log folder + backup buttons, palette commands, adapter restart note', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'native1');

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  const win = page.getByTestId('settings-window');
  await expect(win).toBeVisible();

  // Logs: "Open log folder" calls the native command.
  await win.getByRole('button', { name: 'Logs', exact: true }).click();
  await win.getByTestId('settings-open-logs').click();
  await expect.poll(() => calls(page)).toContain('open_log_folder');
  await expect(win.getByTestId('restart-note-logs.folder')).toBeVisible();

  // Common: "Back up now" backs up and prunes with the maximum; "Open backups folder" opens it.
  await win.getByRole('button', { name: 'Common settings' }).click();
  await win.getByTestId('settings-backup-now').click();
  await expect
    .poll(() => calls(page))
    .toEqual(expect.arrayContaining(['profile_backup_now', 'profile_backup_prune']));
  await expect(page.getByText('Backup created')).toBeVisible();
  await win.getByTestId('settings-open-backups').click();
  await expect.poll(() => calls(page)).toContain('open_backups_folder');

  // Performance: the video adapter shows a "restart required" note.
  await win.getByRole('button', { name: 'Performance' }).click();
  await expect(win.getByTestId('restart-note-performance.videoAdapter')).toBeVisible();

  // Changed settings are mirrored to the core.
  expect(await calls(page)).toContain('native_prefs_set');

  // Command Palette entries.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const input = palette.getByPlaceholder('Search commands, symbols, layouts…');
  await input.fill('Open log folder');
  await expect(palette.getByText('Open log folder').first()).toBeVisible();
  await input.fill('Back up profile now');
  await expect(palette.getByText('Back up profile now').first()).toBeVisible();
  await input.fill('Open backups folder');
  await expect(palette.getByText('Open backups folder').first()).toBeVisible();

  expect(errors).toEqual([]);
});
