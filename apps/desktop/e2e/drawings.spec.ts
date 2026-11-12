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

async function palette(page: Page, query: string) {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search commands, symbols, layouts…').fill(query);
  await page.keyboard.press('Enter');
}

test('multi-select: Shift+click, Ctrl+drag box, group delete + undo via registry shortcuts, group style, alert toggle', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'drawer2');
  const canvas = page.getByTestId('chart-footprint').locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1500);
  const overlay = page.getByTestId('drawings-overlay');
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });

  for (const fy of [0.25, 0.4, 0.55]) {
    await page.keyboard.press('F6');
    const p = at(0.4, fy);
    await page.mouse.click(p.x, p.y);
  }
  await expect(overlay).toHaveAttribute('data-count', '3');

  // Shift+click adds to the selection.
  await page.keyboard.press('Escape');
  await page.mouse.click(at(0.4, 0.25).x, at(0.4, 0.25).y);
  await page.keyboard.down('Shift');
  await page.mouse.click(at(0.4, 0.4).x, at(0.4, 0.4).y);
  await page.keyboard.up('Shift');
  await expect(page.getByTestId('dr-name')).toHaveText('2 selected');
  // Group style edit applies to both.
  await page.getByRole('toolbar', { name: 'Drawing style' }).getByLabel('Colour').fill('#ff0000');

  // Alert toggle exists for lines (group button too).
  const bell = page.getByRole('button', { name: 'Alert on cross' });
  await expect(bell).toHaveAttribute('aria-pressed', 'false');
  await bell.click();
  await expect(bell).toHaveAttribute('aria-pressed', 'true');

  // Ctrl+Z / Ctrl+Y are registry shortcuts: they work with focus on the style toolbar too.
  await page.keyboard.press('Control+z');
  await expect(bell).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+y');
  await expect(bell).toHaveAttribute('aria-pressed', 'true');

  // Delete the group with Del, then undo.
  await page.keyboard.press('Delete');
  await expect(overlay).toHaveAttribute('data-count', '1');
  await page.mouse.click(at(0.9, 0.9).x, at(0.9, 0.9).y);
  await page.keyboard.press('Control+z');
  await expect(overlay).toHaveAttribute('data-count', '3');

  // Ctrl+drag box selects everything it touches.
  await page.mouse.click(at(0.9, 0.9).x, at(0.9, 0.9).y);
  await page.keyboard.down('Control');
  await page.mouse.move(at(0.2, 0.1).x, at(0.2, 0.1).y);
  await page.mouse.down();
  await page.mouse.move(at(0.6, 0.7).x, at(0.6, 0.7).y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect(page.getByTestId('dr-name')).toHaveText('3 selected');
  await page.keyboard.press('Delete');
  await expect(overlay).toHaveAttribute('data-count', '0');
  expect(errors).toEqual([]);
});

test('emoji marker picker with search, regression σ and VWAP band fields, magnet slider, Objects List ribbon button', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'drawer3');
  const canvas = page.getByTestId('chart-footprint').locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1500);
  const overlay = page.getByTestId('drawings-overlay');
  const box = (await canvas.boundingBox())!;

  // Emoji: placing one opens the picker; search narrows the grid.
  await page.getByRole('button', { name: 'Chart Markers', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Emoji/ }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await expect(overlay).toHaveAttribute('data-count', '1');
  const picker = page.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
  const all = await picker.getByRole('option').count();
  await picker.getByLabel('Search emoji').fill('rocket');
  await expect(picker.getByRole('option')).toHaveCount(1);
  expect(all).toBeGreaterThan(50);
  await picker.getByRole('option').click();
  await expect(picker.getByRole('option', { name: 'rocket' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Done' }).click();

  // Regression σ multipliers.
  await page.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Linear Regression Channel/ }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'More properties' }).click();
  await expect(page.getByText('Outer band σ')).toBeVisible();
  await expect(page.getByText('Inner band σ (0 = off)')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // Anchored VWAP band multipliers.
  await page.keyboard.press('F4');
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.getByRole('button', { name: 'More properties' }).click();
  await expect(page.getByText('Band 1 × σ (0 = off)')).toBeVisible();
  await expect(page.getByText('Band 2 × σ (0 = off)')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // Magnet sensitivity slider (pixels) with the presets kept.
  await palette(page, 'Drawing: Preferences');
  const prefs = page.getByTestId('drawing-prefs');
  await expect(prefs).toBeVisible();
  await prefs.getByRole('slider', { name: 'Magnet sensitivity' }).fill('17');
  await expect(prefs.getByText('Magnet sensitivity: 17 px')).toBeVisible();
  await prefs.getByRole('button', { name: '12 px' }).click();
  await expect(prefs.getByText('Magnet sensitivity: 12 px')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // Objects List ribbon button.
  await page.getByTestId('ribbon-drawing-objects').click();
  await expect(page.getByTestId('objects-list')).toBeVisible();
  expect(errors).toEqual([]);
});

test('new tools: ZigZag volume profile, CVD correlation, Magnifier (M), Remove indicators; drawings on both Order Flow panes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'drawer4');
  const canvas = page.getByTestId('chart-footprint').locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1500);
  const overlay = page.getByTestId('drawings-overlay');
  const box = (await canvas.boundingBox())!;

  await page.getByRole('button', { name: 'Volume Analysis', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /^ZigZag Volume Profile/ })).toBeEnabled();
  await expect(page.getByRole('menuitemradio', { name: /^CVD correlation/ })).toBeEnabled();
  await page.getByRole('menuitemradio', { name: /^CVD correlation/ }).click();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  await expect(overlay).toHaveAttribute('data-count', '1');

  // Magnifier toggles with M.
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);
  await page.keyboard.press('m');
  await expect(page.getByText('Magnifier on')).toBeVisible();
  await page.keyboard.press('m');
  await expect(page.getByText('Magnifier off')).toBeVisible();

  // Remove indicators is a registered command.
  await palette(page, 'Drawing: Remove indicators');
  await expect(page.getByText(/No indicators on this chart|Removed \d+ indicator/)).toBeVisible();

  // Order Flow (Dark): both panes take drawings.
  await palette(page, 'Layout: Grid');
  const of = page.getByTestId('chart-order-flow-dark');
  await expect(of).toBeVisible();
  await page.waitForTimeout(1500);
  const canv = of.locator('canvas');
  expect(await canv.count()).toBeGreaterThanOrEqual(2);
  const right = (await canv.nth(1).boundingBox())!;
  const before = Number(await of.getByTestId('drawings-overlay').getAttribute('data-count'));
  await page.keyboard.press('F6');
  await page.mouse.click(right.x + right.width * 0.5, right.y + right.height * 0.5);
  await expect(of.getByTestId('drawings-overlay')).toHaveAttribute(
    'data-count',
    String(before + 1),
  );
  expect(errors).toEqual([]);
});
