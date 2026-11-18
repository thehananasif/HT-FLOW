import { expect, test, type Page } from '@playwright/test';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Window Tester');
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
  await page.getByRole('combobox', { name: 'Search commands, symbols, layouts' }).fill(query);
}

/** Floating windows / dock groups / window tabs. */
const floating = (page: Page) => page.locator('.dv-resize-container');
const groups = (page: Page) => page.locator('.dv-groupview');
const tabs = (page: Page) => page.locator('.dv-tab');

test('split right / split down / detach work, also on floating windows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'split1');
  await expect(page.getByTestId('win-hdr-dom-1')).toBeVisible();
  const before = await groups(page).count();

  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(groups(page)).toHaveCount(before + 1);
  await page.getByRole('button', { name: 'Split down' }).click();
  await expect(groups(page)).toHaveCount(before + 2);

  // Browser build: "Detach window" floats the window inside the main window.
  await expect(floating(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Detach window' }).click();
  await expect(floating(page)).toHaveCount(1);

  // The active window is floating now: splitting it opens a second floating window beside it
  // (it used to add a tab to the floating window instead).
  const tabCount = await tabs(page).count();
  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(floating(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Split down' }).click();
  await expect(floating(page)).toHaveCount(3);
  expect(await tabs(page).count()).toBe(tabCount + 2);
  const boxes = await floating(page).evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    }),
  );
  expect(new Set(boxes.map((b) => `${b.x},${b.y}`)).size).toBe(3); // not stacked on each other

  // Detaching an already floating window keeps one window per floating group.
  await page.getByRole('button', { name: 'Detach window' }).click();
  await expect(floating(page)).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('single-window layout: split and detach from the chart menu and the palette', async ({
  page,
}) => {
  await createAccount(page, 'split2');
  await page.getByTitle('Single').click();
  await expect(groups(page)).toHaveCount(1);
  const host = page.getByTestId('chart-footprint').first();
  await expect(host.locator('canvas').first()).toBeVisible();
  const box = (await host.boundingBox())!;
  await host.click({ button: 'right', position: { x: box.width / 2, y: 150 } });
  await page.getByRole('menuitem', { name: 'Layouts' }).first().hover();
  await page.getByRole('menuitem', { name: 'Split right' }).first().click();
  await expect(groups(page)).toHaveCount(2);

  await palette(page, 'Split down');
  await page.keyboard.press('Enter');
  await expect(groups(page)).toHaveCount(3);

  await palette(page, 'Detach window: floating');
  await page.keyboard.press('Enter');
  await expect(floating(page)).toHaveCount(1);
});

test('OS window commands are registered and fall back to floating windows in a browser', async ({
  page,
}) => {
  await createAccount(page, 'oswin1');
  await expect(page.getByTestId('win-hdr-dom-1')).toBeVisible();

  // Command Palette lists the OS-window commands.
  await palette(page, 'OS window');
  for (const label of [
    'Detach window to a new OS window',
    'Re-attach all OS windows',
    'Re-attach active window from its OS window',
    'Window: Clone active window in new OS window',
  ])
    await expect(page.getByRole('option', { name: new RegExp(label) }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // "Detach window to a new OS window" floats in the browser build.
  await page.getByTestId('win-hdr-dom-1').click({ position: { x: 4, y: 4 } });
  await palette(page, 'Detach window to a new OS window');
  await page.keyboard.press('Enter');
  await expect(floating(page)).toHaveCount(1);
  await expect(page.getByText('Separate OS windows need the desktop app.')).toBeVisible();

  // Panel menu: Detach to OS window, Clone / Create linked … in new OS window.
  await page.getByTestId('win-menu-chart-1').click();
  await expect(page.getByRole('menuitem', { name: /Detach to OS window/ })).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: /Create linked window in new OS window/ }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: /Clone window in new OS window/ }).click();
  await expect(floating(page)).toHaveCount(2);

  // Settings → Layout: the default detach target is a wired option.
  await page.getByTestId('workspace-menu').click();
  await page.getByRole('menuitem', { name: 'Layout settings…' }).click();
  await expect(page.getByText('Detach window opens').first()).toBeVisible();

  // Workspaces ▾ → Open workspace in new window (browser: floating windows).
  await page.getByTestId('workspace-menu').click();
  await page.getByRole('menuitem', { name: 'Save as…' }).click();
  await page.getByLabel('Workspace name').fill('Second screen');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('workspace-menu').click();
  await expect(page.getByRole('menuitem', { name: 'Open workspace in new window' })).toBeVisible();
  await page.keyboard.press('Escape');
  await palette(page, 'Workspace: Open Second screen in new window');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Opened "Second screen" as floating windows/)).toBeVisible();
  expect(await floating(page).count()).toBeGreaterThan(2);
});

test('the secondary-window route renders only the compact window chrome', async ({ page }) => {
  await page.goto('/?window=ht-w-e2etest');
  await expect(page.getByTestId('os-window')).toBeVisible();
  await expect(page.getByTestId('os-window-reattach')).toBeVisible();
  await expect(page.getByText('Waiting for the main window…')).toBeVisible();
  // No main chrome: no ribbon, layout tabs, login form or trading panel.
  await expect(page.getByTestId('ribbon-workspaces')).toHaveCount(0);
  await expect(page.locator('.ws-tabs')).toHaveCount(0);
  await expect(page.locator('form.create-form')).toHaveCount(0);
  await expect(page.getByTestId('trading-panel')).toHaveCount(0);
  // A bad label is not a secondary window: the normal app (login) shows.
  await page.goto('/?window=main');
  await expect(page.getByTestId('os-window')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create account' }).first()).toBeVisible();
});
