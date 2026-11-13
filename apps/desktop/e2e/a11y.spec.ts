import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * P29 accessibility pass: axe-core (WCAG 2.1 A / AA rules) on the main screens, failing on serious
 * or critical violations, plus keyboard-only checks of the ribbon, the Command Palette and dialogs.
 */

type Violation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown; html: string; any: { data?: unknown }[] }[];
};

async function audit(page: Page, scope?: string): Promise<Violation[]> {
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (scope) b = b.include(scope);
  const res = await b.analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of bad)
    console.log(
      `[axe] ${scope ?? 'page'}: ${v.id} (${v.impact}) ${v.help}\n  ` +
        v.nodes
          .slice(0, 6)
          .map((n) => `${JSON.stringify(n.target)} ${n.html.slice(0, 160)}`)
          .join('\n  '),
    );
  return bad;
}

const ids = (vs: Violation[]) => vs.map((v) => `${v.id} ×${v.nodes.length}`);

async function createAccount(page: Page, username: string) {
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('A11y Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('chart-footprint')).toBeVisible();
  await page.waitForTimeout(1500); // history load
}

const openModule = (page: Page, id: string) =>
  page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('htflow:open-module', { detail })),
    id,
  );

test('axe: login, dashboard, Settings, Indicators, Alerts, Command Palette', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create account' }).first()).toBeVisible();
  const found: Record<string, string[]> = {};
  found.login = ids(await audit(page));

  await createAccount(page, 'a11y1');
  found.dashboard = ids(await audit(page));

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+Comma');
  await expect(page.getByTestId('settings-window')).toBeVisible();
  found.settings = ids(await audit(page, '[data-testid="settings-window"]'));
  await page.keyboard.press('Escape');

  await page.getByTestId('indicators-button').first().click();
  await expect(page.getByTestId('indicators-dialog')).toBeVisible();
  found.indicators = ids(await audit(page, '[data-testid="indicators-dialog"]'));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('indicators-dialog')).toBeHidden();

  await openModule(page, 'alerts');
  await expect(page.getByTestId('alerts-window').last()).toBeVisible();
  found.alerts = ids(await audit(page, '[data-testid="alerts-window"]'));

  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Search commands, symbols, layouts…').fill('chart');
  found.palette = ids(await audit(page, '[role="dialog"][aria-label="Command palette"]'));

  expect(found).toEqual({
    login: [],
    dashboard: [],
    settings: [],
    indicators: [],
    alerts: [],
    palette: [],
  });
  expect(errors).toEqual([]);
});

const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const cs = el ? getComputedStyle(el) : null;
    return {
      testid: el?.getAttribute('data-testid') ?? '',
      // A visible focus indicator: outline or box-shadow on the focused element.
      ring: !!cs && (cs.outlineStyle !== 'none' || cs.boxShadow !== 'none'),
    };
  });

const focusInside = (page: Page, sel: string) =>
  page.evaluate((s) => !!document.querySelector(s)?.contains(document.activeElement), sel);

test('keyboard only: ribbon, Command Palette, Settings and Indicators dialogs, layout tabs', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await createAccount(page, 'a11ykeys');

  // Ribbon: sequential focus reaches it (Shift+Tab from the DOM window, which sits after the
  // ribbon in tab order), focus is visible, arrows move along it, Enter opens a module.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  let a = await active(page);
  for (let k = 0; k < 150 && !a.testid.startsWith('ribbon-'); k++) {
    await page.keyboard.press('Shift+Tab');
    a = await active(page);
  }
  expect(a.testid).toMatch(/^ribbon-/);
  expect(a.ring).toBe(true);
  const last = a.testid; // Shift+Tab enters the ribbon at its last button
  await page.keyboard.press('Home');
  const first = (await active(page)).testid;
  expect(first).toMatch(/^ribbon-/);
  expect(first).not.toBe(last);
  await page.keyboard.press('ArrowRight');
  expect((await active(page)).testid).not.toBe(first);
  await page.keyboard.press('ArrowLeft');
  expect((await active(page)).testid).toBe(first);
  await page.keyboard.press('End');
  expect((await active(page)).testid).toBe(last);
  await page.keyboard.press('Home');
  for (let k = 0; k < 60 && (await active(page)).testid !== 'ribbon-alerts'; k++)
    await page.keyboard.press('ArrowRight');
  expect((await active(page)).testid).toBe('ribbon-alerts');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('alerts-window').last()).toBeVisible();

  // Command Palette: combobox with the active option announced, arrows, Escape.
  await page.keyboard.press('Control+k');
  const combo = page.getByRole('combobox', { name: /Search commands/ });
  await expect(combo).toBeFocused();
  await page.keyboard.type('settings');
  await expect(combo).toHaveAttribute('aria-activedescendant', 'palette-opt-0');
  await page.keyboard.press('ArrowDown');
  await expect(combo).toHaveAttribute('aria-activedescendant', 'palette-opt-1');
  await expect(page.locator('#palette-opt-1')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();

  // Settings: opens from the keyboard, Tab moves through its controls with a visible ring.
  await page.keyboard.press('Control+Comma');
  await expect(page.getByTestId('settings-window')).toBeVisible();
  const inSettings = () => focusInside(page, '[data-testid="settings-window"]');
  for (let k = 0; k < 40 && !(await inSettings()); k++) await page.keyboard.press('Tab');
  expect(await inSettings()).toBe(true);
  for (let k = 0; k < 4; k++) {
    await page.keyboard.press('Tab');
    expect((await active(page)).ring).toBe(true);
  }
  await page.keyboard.press('Escape');

  // Indicators dialog: keyboard activation, focus moves in and stays in, Escape returns focus.
  const btn = page.getByTestId('indicators-button').first();
  await btn.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByTestId('indicators-dialog');
  await expect(dlg).toBeVisible();
  const inDialog = () => focusInside(page, '[data-testid="indicators-dialog"]');
  await expect.poll(inDialog).toBe(true);
  for (let k = 0; k < 12; k++) {
    await page.keyboard.press('Tab');
    expect(await inDialog()).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(btn).toBeFocused();

  // Layout tabs: add one, arrows move between tabs, Enter switches, roving tabindex follows.
  await page.getByRole('button', { name: 'Add layout' }).click();
  const tabs = page.getByRole('tablist', { name: 'Workspace layouts' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');

  expect(errors).toEqual([]);
});
