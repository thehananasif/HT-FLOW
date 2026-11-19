import { expect, test } from '@playwright/test';

test('Urdu: language picker + palette switch to RTL, translated menu, charts stay LTR', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Urdu Tester');
  await inputs.nth(1).fill('urdu1');
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const chart = page.getByTestId('chart-footprint').first();
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  // Command Palette lists both language commands.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('Language');
  await expect(palette.getByRole('option', { name: /Language: English/ })).toBeVisible();
  await expect(palette.getByRole('option', { name: /Language: اردو/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Settings → General → Language lists English / اردو and switches live on Apply.
  await page.keyboard.press('Control+,');
  const win = page.getByTestId('settings-window');
  await expect(win).toBeVisible();
  await win.getByRole('button', { name: 'General', exact: true }).click();
  const lang = win.getByLabel('Language', { exact: true });
  await expect(lang.locator('option').nth(0)).toHaveText('English');
  await expect(lang.locator('option').nth(1)).toHaveText('اردو (Urdu, RTL)');
  await lang.selectOption('ur');
  await win.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ur');

  // The Settings page heading and its section list switch to Urdu, and so does the ribbon.
  await page.keyboard.press('Control+,');
  const settingsWin = page.getByTestId('settings-window');
  await expect(settingsWin.locator('h2').first()).toHaveText('عمومی');
  await expect(settingsWin.getByRole('button', { name: 'ظاہری شکل' })).toBeVisible();
  await expect(settingsWin.getByText('زبان اور خطہ')).toBeVisible();
  await expect(page.getByTestId('ribbon-watchlist')).toContainText('واچ لسٹ');
  await expect(page.getByTestId('ribbon-connections')).toContainText('کنکشنز');
  await expect(page.getByRole('navigation', { name: 'ربن' })).toBeVisible();
  await page.screenshot({ path: '../../docs/screenshots/urdu-settings.png' });

  // The chart survives the live switch, stays LTR, and its right-click menu is in Urdu.
  // Settings shares a tab group with the chart: bring the chart tab back.
  await page.getByText('CLZ6 Footprint', { exact: true }).first().click();
  const chart2 = page.getByTestId('chart-footprint').first();
  const canvas = chart2.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  expect(await canvas.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
  expect(await chart2.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
  const box = (await chart2.boundingBox())!;
  await chart2.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  await expect(page.getByRole('menuitem', { name: /^سیٹنگز…/ }).first()).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Settings…/ })).toHaveCount(0);
  await page.screenshot({ path: '../../docs/screenshots/urdu-rtl.png' });
  await page.keyboard.press('Escape');

  // Command Palette switches back.
  await page.keyboard.press('Control+k');
  const p2 = page.getByRole('dialog', { name: 'کمانڈ پیلیٹ' });
  await p2.getByPlaceholder('کمانڈز، سمبلز، لے آؤٹس تلاش کریں…').fill('Language');
  await p2.getByRole('option', { name: /زبان: English/ }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
});
