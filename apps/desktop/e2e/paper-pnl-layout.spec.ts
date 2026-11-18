import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'Str0ng!Passw0rd';

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('PnL Tester');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill(PASSWORD);
  await inputs.nth(4).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
  await page.waitForTimeout(1500); // history load
}

/** Pauses the active chart's simulator and sets the market by hand (book + one trade). */
async function setMarket(page: Page, offsetTicks: number) {
  return page.evaluate(async (off) => {
    // Dev-server modules (paths are not resolvable by the test's TypeScript).
    const load = (p: string) => import(/* @vite-ignore */ p);
    const m = await load('/src/state/market.ts');
    const w = await load('/src/state/windows.ts');
    const id = w.activeInstrument()!;
    m.hub.feed(id)?.stop();
    const store = m.hub.peek(id)!;
    const pos = m.paper.position(m.paper.route('paper-3505', id), id);
    const base = pos.qty ? Math.round(pos.avgPx) : (store.lastTrade?.px ?? store.book.mid);
    const px = base + off;
    const ts = Date.now();
    store.ingest({
      ts,
      deltas: [],
      snapshot: { ts, bids: [[px, 50]], asks: [[px + 1, 50]] },
      trades: [{ ts, px, qty: 1, side: 'buy', id: 9_000_000 + off }],
    });
    return { id, px, pnlTick: m.pnlTick(id) };
  }, offsetTicks);
}

const confirmIfAsked = async (page: Page) => {
  const ok = page
    .getByRole('dialog')
    .getByRole('button', { name: /^(Close position|Confirm|OK)$/ });
  if (await ok.isVisible({ timeout: 800 }).catch(() => false)) await ok.click();
};

test('paper buy → price moves → non-zero open P&L → close → realized P&L', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, 'pnl1');
  await page.getByTestId('chart-footprint').click({ position: { x: 5, y: 5 } });
  const panel = page.getByTestId('trading-panel');

  // A fixed market (simulator paused): buy 1 at the ask.
  await setMarket(page, 0);
  await panel.getByTestId('buy-market').click();
  await expect(panel.getByTestId('position-qty')).toHaveText('1');

  // Price 50 ticks above the entry: open P&L = 50 ticks × tick value, everywhere.
  const { pnlTick } = await setMarket(page, 50);
  const open = (50 * pnlTick).toFixed(2);
  await expect(panel.getByTestId('pnl')).toHaveAttribute('data-value', open);
  await expect(panel.getByTestId('pnl')).toContainText(`+${open}`);
  await expect(page.getByTestId('status-pnl-open')).toContainText(open);

  // Close at the bid (= the moved price): the gain becomes realized and open P&L returns to 0.
  await panel.getByTestId('close-position').click();
  await confirmIfAsked(page);
  await expect(panel.getByTestId('position-qty')).toHaveText('0');
  await expect(panel.getByTestId('pnl')).toHaveAttribute('data-value', '0.00');
  await expect(panel.getByTestId('pnl-realized')).toHaveAttribute('data-value', open);
  await expect(panel.getByTestId('tp-foot')).toContainText('Since reset');

  // Trade history shows the realized fill.
  await page.getByTestId('ribbon-trades').click();
  await expect(
    page
      .getByText(`+${Number(open).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
      .first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('small windows', () => {
  test.use({ viewport: { width: 1366, height: 700 } });

  test('Trading Panel at 260 / 240 px and 1366 × 700: no horizontal overflow, all reachable', async ({
    page,
  }) => {
    await createAccount(page, 'pnl2');
    await page.getByTestId('chart-footprint').click({ position: { x: 5, y: 5 } });
    const panel = page.getByTestId('trading-panel');
    for (const width of [260, 240]) {
      const r = await panel.evaluate((el, w) => {
        el.style.setProperty('--tp-width', `${w}px`);
        const box = el.getBoundingClientRect();
        const wide = [...el.querySelectorAll<HTMLElement>('*')]
          .filter((c) => {
            const b = c.getBoundingClientRect();
            return b.width > 0 && b.right > box.right + 1;
          })
          .map((c) => c.className || c.tagName);
        return { sw: el.scrollWidth, cw: el.clientWidth, w: box.width, wide };
      }, width);
      expect(r.w).toBe(width);
      expect(r.sw).toBeLessThanOrEqual(r.cw);
      expect(r.wide).toEqual([]);
    }
    // The last control (the account footer) scrolls into view inside the panel.
    const foot = panel.getByTestId('tp-foot');
    await foot.scrollIntoViewIfNeeded();
    await expect(foot).toBeInViewport();
    const inside = await panel.evaluate((el) => {
      const f = el.querySelector('[data-testid="tp-foot"]')!.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return f.bottom <= b.bottom + 1 && f.top >= b.top - 1;
    });
    expect(inside).toBe(true);
  });

  test('chart drawing tools: the last tool group stays reachable on a short window', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 520 });
    await createAccount(page, 'pnl3');
    const rail = page.getByTestId('sidetools').first();
    await expect(rail).toBeVisible();
    const st = await rail.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(st.sh).toBeLessThanOrEqual(st.ch + 1);
    const more = rail.getByTestId('sidetools-more');
    let objects = rail.getByRole('button', { name: /Objects/ });
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      const menu = rail.getByRole('menu', { name: 'More tools' });
      await expect(menu).toBeVisible();
      objects = menu.getByRole('menuitem', { name: /Objects/ });
    }
    await objects.click();
    await expect(rail.getByRole('menuitem', { name: 'Objects List' })).toBeVisible();
  });

  test('settings: section list and OK button reachable at 1366 × 700', async ({ page }) => {
    await createAccount(page, 'pnl4');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('Control+Comma');
    const win = page.getByTestId('settings-window');
    await expect(win).toBeVisible();
    const ok = win.getByRole('button', { name: 'OK', exact: true });
    await ok.scrollIntoViewIfNeeded();
    await expect(ok).toBeInViewport();
    const last = win.locator('.st-nav-foot button').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });
});
