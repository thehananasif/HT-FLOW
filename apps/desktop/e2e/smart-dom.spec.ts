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

interface Layout {
  header: number;
  row: number;
  cols: { id: string; x: number; w: number }[];
}

async function layout(page: Page): Promise<Layout> {
  const raw = await page.getByTestId('dom-ladder').first().getAttribute('data-layout');
  return JSON.parse(raw ?? '{"cols":[]}') as Layout;
}

test('Smart DOM: switch template, toggle a column, add a price note, save a custom template', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'domtrader');
  const ladder = page.getByTestId('dom-ladder').first();
  await expect(ladder).toBeVisible();
  await expect(ladder).toHaveAttribute('data-template', 'basic-extended');

  // 1. Switch template from the DOM header.
  await page.getByTestId('dom-template-menu').first().click();
  await page.getByRole('menuitem', { name: 'Dark (with notes)' }).click();
  await expect(ladder).toHaveAttribute('data-template', 'dark-notes');
  await expect(page.getByTestId('dom-template-menu').first()).toContainText('Dark (with notes)');
  expect((await layout(page)).cols.map((c) => c.id)).toContain('notes');

  // 2. Toggle a column (cumulative bid depth) on, then off.
  expect((await layout(page)).cols.map((c) => c.id)).not.toContain('cumBid');
  await page.getByTestId('dom-columns-menu').first().click();
  await page.getByRole('menuitem', { name: 'Σ Bid' }).click();
  await expect.poll(async () => (await layout(page)).cols.map((c) => c.id)).toContain('cumBid');
  await page.getByTestId('dom-columns-menu').first().click();
  await page.getByRole('menuitem', { name: 'Σ Bid' }).click();
  await expect.poll(async () => (await layout(page)).cols.map((c) => c.id)).not.toContain('cumBid');

  // 3. Add a price note: click the Notes column, type, Enter.
  const l = await layout(page);
  const notes = l.cols.find((c) => c.id === 'notes')!;
  const wrap = page.locator('.dom-canvas-wrap').first();
  await expect(async () => {
    await ladder.click({ position: { x: notes.x + 8, y: l.header + l.row * 4 + l.row / 2 } });
    await expect(page.getByTestId('dom-note-input')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('dom-note-input').fill('Weekly high');
  await page.getByTestId('dom-note-input').press('Enter');
  await expect(page.getByTestId('dom-note-input')).toHaveCount(0);
  await expect(wrap).toHaveAttribute('data-notes', '1');
  // Re-opening the same row shows the saved note.
  await ladder.click({ position: { x: notes.x + 8, y: l.header + l.row * 4 + l.row / 2 } });
  await expect(page.getByTestId('dom-note-input')).toHaveValue('Weekly high');
  await page.getByTestId('dom-note-input').press('Escape');

  // 4. Save a custom template from the designer and apply it.
  await page.getByRole('button', { name: 'Template designer' }).first().click();
  const designer = page.getByTestId('dom-designer');
  await expect(designer).toBeVisible();
  await designer.getByRole('button', { name: 'Duplicate' }).click();
  await designer.getByLabel('Template name').fill('My scalping DOM');
  await designer.getByRole('tab', { name: 'Style', exact: true }).click();
  await designer.getByLabel('Row height').fill('18');
  await designer.getByLabel('Row height').press('Enter');
  await designer.getByRole('button', { name: 'Save & apply' }).click();
  await expect(ladder).toHaveAttribute('data-template', /^custom-/);
  await page.keyboard.press('Escape');
  await expect(designer).toHaveCount(0);
  await expect(page.getByTestId('dom-template-menu').first()).toContainText('My scalping DOM');
  await page.getByTestId('dom-template-menu').first().click();
  await expect(page.getByRole('menuitem', { name: 'My scalping DOM' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Commands are in the palette.
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search commands, symbols, layouts…').fill('use template Prop DOM');
  const useProp = page.getByRole('option', { name: /Smart DOM: use template Prop DOM/ });
  await expect(useProp).toBeVisible();
  // Click the exact command (Enter runs whichever row is selected, which can shift while the
  // list re-renders on a busy machine), then make sure the palette closed and the ladder switched.
  await useProp.click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  await expect(ladder).toHaveAttribute('data-template', 'prop');
  await expect(page.getByTestId('dom-risk')).toBeVisible();

  expect(errors).toEqual([]);
});
