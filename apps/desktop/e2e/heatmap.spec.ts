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
  const code = page.getByTestId('recovery-code');
  await expect(code.locator('li')).toHaveCount(24);
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

test('Heatmap: open from the ribbon, change gradient, toggle bubbles and 3D', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'heattrader');

  // 1. Ribbon → Heatmap opens the standalone module window.
  await page.getByTestId('ribbon-heatmap').click();
  const win = page.getByTestId('heatmap-window');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('chart-heatmap')).toBeVisible();
  await expect(win.locator('.hm-host canvas')).toBeVisible();
  await expect(win.getByRole('toolbar', { name: 'Drawing tools' })).toBeVisible();

  // 2. Quick settings: exactly the spec sections, each with a help icon.
  await win.getByTestId('heatmap-settings-button').click();
  const qs = page.getByTestId('heatmap-quick-settings');
  await expect(qs).toBeVisible();
  for (const id of ['heatmap', 'bubbles', 'bba', 'dom', 'volume', '3d'])
    await expect(qs.getByTestId(`hm-sec-${id}`).locator('.hm-sec-head .hm-help')).toHaveCount(1);

  // 3. Change the gradient: preset, then the custom gradient editor.
  await expect(win).toHaveAttribute('data-gradient', 'thermal');
  await qs.getByRole('combobox', { name: 'Heat map colour' }).selectOption('viridis');
  await expect(win).toHaveAttribute('data-gradient', 'viridis');
  await qs.getByRole('button', { name: 'Edit gradient' }).click();
  const editor = qs.getByTestId('heatmap-gradient-editor');
  await expect(editor).toBeVisible();
  await editor.getByRole('spinbutton', { name: 'Stop 1 position %' }).fill('10');
  await expect(win).toHaveAttribute('data-gradient', 'custom');

  // 4. Toggle bubbles off and on, switch the fill style.
  await expect(win).toHaveAttribute('data-bubbles', 'on');
  const bubbles = qs.getByTestId('hm-sec-bubbles').getByRole('checkbox').first();
  await bubbles.uncheck();
  await expect(win).toHaveAttribute('data-bubbles', 'off');
  await bubbles.check();
  await expect(win).toHaveAttribute('data-bubbles', 'on');
  await qs.getByRole('group', { name: 'Fill' }).getByRole('button', { name: 'Dominant' }).click();
  await expect(win).toHaveAttribute('data-bubble-style', 'dominant');

  // Normalise per column.
  await qs
    .getByRole('group', { name: 'Normalise' })
    .getByRole('button', { name: 'Per column' })
    .click();
  await expect(win).toHaveAttribute('data-normalize', 'column');
  await page.keyboard.press('Escape');
  await expect(qs).toHaveCount(0);

  // 5. Full settings dialog: order features.
  await win.getByRole('button', { name: 'Open full settings' }).click();
  const full = page.getByTestId('heatmap-full-settings');
  await expect(full).toBeVisible();
  await full.getByRole('tab', { name: 'Orders' }).click();
  for (const label of [
    'Outline large orders',
    'Colour by order lifetime',
    'Iceberg markers',
    'Spoof flashes',
  ])
    await full.getByLabel(label).check();
  await full.getByRole('button', { name: 'Done' }).click();

  // Left toolbar: draw a rectangle and see it in the objects list.
  const tools = win.getByRole('toolbar', { name: 'Drawing tools' });
  await tools.getByRole('button', { name: 'Rectangle' }).click();
  const area = (await win.getByTestId('chart-heatmap').boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.3, area.y + area.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.45, area.y + area.height * 0.45, { steps: 5 });
  await page.mouse.up();
  await tools.getByRole('button', { name: 'Objects list' }).click();
  await expect(
    win.getByRole('dialog', { name: 'Objects list' }).getByText('Rectangle'),
  ).toBeVisible();
  await tools.getByRole('button', { name: 'Objects list' }).click();

  // 6. Toggle 3D on and off.
  await win.getByTestId('heatmap-3d-toggle').click();
  await expect(win).toHaveAttribute('data-mode3d', 'on');
  const view3d = win.getByTestId('heatmap-3d');
  await expect(view3d).toBeVisible();
  await expect(view3d).toHaveAttribute('data-renderer', /webgl|canvas/);
  await expect(view3d.locator('canvas')).toBeVisible();
  // Orbit by dragging.
  const box = (await view3d.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await win.getByTestId('heatmap-3d-toggle').click();
  await expect(win).toHaveAttribute('data-mode3d', 'off');
  await expect(view3d).toHaveCount(0);

  // 7. Commands are in the Command Palette.
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox');
  await expect(search).toBeFocused();
  await search.fill('Heatmap: toggle 3D');
  await expect(page.getByRole('option', { name: /Heatmap: toggle 3D mode/ })).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});
