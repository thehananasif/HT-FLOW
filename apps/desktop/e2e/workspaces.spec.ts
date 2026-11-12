import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Workspace Tester');
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

const tabs = (page: Page) => page.locator('.dv-tab');

test('workspaces: save, change layout, load back, export / import, clone a chart', async ({
  page,
}) => {
  await createAccount(page, 'ws1');
  await expect(page.getByTestId('win-hdr-dom-1')).toBeVisible();

  // The ribbon ▾ lists workspaces and opens the manager.
  await page.getByTestId('ribbon-workspaces').click();
  await expect(page.getByRole('menuitem', { name: 'Save current' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Workspaces manager…' }).click();
  const win = page.getByTestId('workspaces-window');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('ws-starter')).toHaveCount(8);

  // Save as…
  await win.getByTestId('ws-save-as').click();
  await page.getByLabel('Workspace name').fill('Desk A');
  await page.getByLabel('Workspace description').fill('DOM + footprint');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const card = win.locator('[data-testid="ws-card"][data-name="Desk A"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Loaded');
  await expect(page.getByTestId('workspace-menu')).toContainText('Desk A');
  const savedTabs = await tabs(page).count();

  // Change the layout: Grid 2×2 replaces every window.
  await page.getByTitle('Grid 2×2').click();
  await expect(page.getByTestId('win-hdr-chart-4')).toBeVisible();
  await expect(page.getByTestId('win-hdr-dom-1')).toHaveCount(0);

  // Load the saved workspace back from the title-bar menu.
  await page.getByTestId('workspace-menu').click();
  await page
    .getByRole('menuitem', { name: /Desk A/ })
    .first()
    .click();
  await expect(page.getByTestId('win-hdr-dom-1')).toBeVisible();
  await expect(page.getByTestId('win-hdr-chart-4')).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(savedTabs);

  // Export the selected workspace as .htworkspace.
  const ws = page.getByTestId('workspaces-window');
  await ws.locator('[data-testid="ws-card"][data-name="Desk A"]').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    ws.getByTestId('ws-selbar').getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Desk A.htworkspace');
  const path = await download.path();
  const text = readFileSync(path!, 'utf8');
  const file = JSON.parse(text);
  expect(file).toMatchObject({ format: 'htworkspace', version: 3 });
  expect(file.workspace.meta.name).toBe('Desk A');
  expect(Object.keys(file.workspace.doc.tabs[0].windows)).toContain('dom-1');

  // Import it back: a second copy appears with a unique name.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    ws.getByTestId('ws-import').click(),
  ]);
  await chooser.setFiles({
    name: 'Desk A.htworkspace',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(ws.locator('[data-testid="ws-card"][data-name="Desk A (2)"]')).toBeVisible();

  // A hostile file is refused.
  const [chooser2] = await Promise.all([
    page.waitForEvent('filechooser'),
    ws.getByTestId('ws-import').click(),
  ]);
  await chooser2.setFiles({
    name: 'evil.htworkspace',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"htworkspace","version":3,"workspace":{"doc":{"tabs":[]}}}'),
  });
  await expect(page.getByText('Cannot import evil.htworkspace')).toBeVisible();
  await expect(ws.getByTestId('ws-card')).toHaveCount(2);

  // Clone a chart window from its header menu: the copy keeps its settings.
  await page.getByTitle('Grid 2×2').click();
  await expect(page.getByTestId('win-hdr-chart-2')).toBeVisible();
  const before = await tabs(page).count();
  await page.getByTestId('win-menu-chart-2').click();
  await page.getByRole('menuitem', { name: 'Clone window' }).click();
  await expect(tabs(page)).toHaveCount(before + 1);
  await expect(page.locator('[data-testid^="win-hdr-chart-"]')).toHaveCount(5);
  await expect(page.getByTestId('template-menu').filter({ hasText: 'Footprint' })).toHaveCount(2);

  // Create linked window ▸ DOM from the palette (active window).
  await palette(page, 'Window: Create linked DOM');
  await expect(page.locator('[data-testid^="win-hdr-dom-"]')).toHaveCount(1);
});

test('layout settings: options persist and apply to the document', async ({ page }) => {
  await createAccount(page, 'ws2');
  await palette(page, 'Open Layout Settings');
  const win = page.getByTestId('layout-settings');
  await expect(win).toBeVisible();
  await win
    .getByRole('group', { name: 'Header density' })
    .getByRole('button', { name: 'Compact' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-ht-header', 'compact');
  await win
    .getByRole('group', { name: 'Layout tabs position' })
    .getByRole('button', { name: 'Top' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-ht-layout-tabs', 'top');
  await win
    .getByRole('group', { name: 'Other windows open' })
    .getByRole('button', { name: 'Floating' })
    .click();
  // A new module window now opens floating.
  await page.getByTestId('ribbon-logs').click();
  await expect(page.locator('.dv-groupview-floating, .dv-resize-container')).not.toHaveCount(0);
});
