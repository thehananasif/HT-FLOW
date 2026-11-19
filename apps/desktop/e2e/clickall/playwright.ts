/** Playwright adapter for the framework-agnostic crawler (clickall/core.ts). */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import type { Driver } from './core';

const here = dirname(fileURLToPath(import.meta.url));
export const INPAGE_SOURCE = readFileSync(join(here, 'inpage.js'), 'utf8');
/** apps/desktop/test-results/click-report */
export const REPORT_DIR = join(here, '..', '..', 'test-results', 'click-report');

export function playwrightDriver(page: Page): Driver {
  const extra: string[] = [];
  page.on('crash', () => extra.push('pageerror: renderer process crashed'));
  mkdirSync(join(REPORT_DIR, 'shots'), { recursive: true });
  return {
    exec: <T>(expression: string) => page.evaluate(expression) as Promise<T>,
    async click(selector, opts) {
      await page
        .locator(selector)
        .first()
        .click({
          timeout: 1500,
          button: opts?.button ?? 'left',
          position: opts?.x !== undefined ? { x: opts.x, y: opts.y ?? 0 } : undefined,
        });
    },
    async contextClick(x, y) {
      await page.mouse.click(x, y, { button: 'right' });
    },
    press: (key) => page.keyboard.press(key),
    async screenshot(name, selector) {
      const rel = `shots/${name}.png`;
      const path = join(REPORT_DIR, rel);
      try {
        if (selector) await page.locator(selector).first().screenshot({ path, timeout: 3000 });
        else await page.screenshot({ path });
        return rel;
      } catch {
        return undefined;
      }
    },
    sleep: (ms) => page.waitForTimeout(ms),
    drainExtraErrors: () => extra.splice(0, extra.length),
  };
}

/** Installs the in-page probe on every navigation (so start-up errors are captured too). */
export async function installProbe(page: Page): Promise<void> {
  await page.addInitScript({ content: INPAGE_SOURCE });
}

export async function createAccount(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Click Crawler');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await expect(page.getByTestId('app-heartbeat')).toBeAttached();
}
