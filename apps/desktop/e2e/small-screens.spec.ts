import { expect, test, type Page } from '@playwright/test';

/**
 * Round 7: every ribbon module must work on a small laptop screen (1280 x 600): nothing sticks
 * out of its window sideways (unless inside a scroll container) and the last control of the
 * window can be reached by scrolling.
 */

async function createAccount(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create account' }).first().click();
  const inputs = page.locator('form.create-form input');
  await inputs.nth(0).fill('Small Screen');
  await inputs.nth(1).fill(username);
  await inputs.nth(3).fill('Str0ng!Passw0rd');
  await inputs.nth(4).fill('Str0ng!Passw0rd');
  await page.getByRole('button', { name: 'Create account' }).last().click();
  await page.getByText('I have saved my recovery code').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('trading-panel')).toBeVisible();
}

interface Finding {
  kind: 'overflow-x' | 'last-control';
  detail: string;
}

/** Runs in the page: audits the container matched by `rootSelector`. */
function audit(rootSelector: string): Finding[] {
  const root = document.querySelector<HTMLElement>(rootSelector);
  if (!root) return [{ kind: 'overflow-x', detail: `no container ${rootSelector}` }];
  const out: Finding[] = [];
  const box = root.getBoundingClientRect();
  const label = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(
      (el as HTMLElement).className || '',
    )
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('.')}[${(el.textContent ?? '').trim().slice(0, 24)}]`;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // A box is "cut off sideways" when it extends past the container's right edge and no ancestor
  // between it and the container is a horizontal scroller (then the user can scroll to it).
  const scrolls = (el: Element) => {
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
    return false;
  };
  const seen = new Set<string>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (!visible(el) || el.closest('svg') || getComputedStyle(el).position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.right > box.right + 1 && !scrolls(el)) {
      const key = label(el);
      if (!seen.has(key) && seen.size < 6)
        out.push({
          kind: 'overflow-x',
          detail: `${key} right=${Math.round(r.right)} > ${Math.round(box.right)}`,
        });
      seen.add(key);
    }
  }
  // Containers that clip their content sideways without a scrollbar hide controls for good.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue;
    if (cs.textOverflow === 'ellipsis' || el.scrollWidth <= el.clientWidth + 1) continue;
    // Only boxes with controls inside matter (truncated plain text is fine).
    if (!el.querySelector('button, input, select, textarea, a[href], [role="tab"]')) continue;
    const key = `clipped ${label(el)} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`;
    if (!seen.has(key) && seen.size < 6) out.push({ kind: 'overflow-x', detail: key });
    seen.add(key);
  }
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="tab"]',
    ),
  ).filter(
    (el) =>
      visible(el) &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest(
        '[aria-hidden="true"], [hidden], .ht-popover, [data-radix-popper-content-wrapper]',
      ),
  );
  const last = focusable[focusable.length - 1];
  if (last) {
    last.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = last.getBoundingClientRect();
    const inside =
      r.bottom <= Math.min(box.bottom, innerHeight) + 1 &&
      r.top >= Math.max(box.top, 0) - 1 &&
      r.right <= Math.min(box.right, innerWidth) + 1 &&
      r.left >= box.left - 1;
    const hit = document.elementFromPoint(
      Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
      Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1),
    );
    const reachable = inside && !!hit && (last.contains(hit) || hit.contains(last));
    if (!reachable)
      out.push({
        kind: 'last-control',
        detail: `${label(last)} rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} box=${Math.round(box.right)},${Math.round(box.bottom)} inside=${inside} hit=${hit ? label(hit) : 'none'}`,
      });
  }
  return out;
}

const ACTIVE_WINDOW = '.dv-groupview.dv-active-group .dv-content-container';

const SIZES = [
  { width: 1280, height: 600 },
  { width: 1366, height: 700 },
];

for (const size of SIZES) {
  const tag = `${size.width}x${size.height}`;

  test(`every ribbon module fits a ${tag} screen: no sideways overflow, last control reachable`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await createAccount(page, `small-${tag}`);
    await page.waitForTimeout(1000);

    const modules = await page.evaluate(async () => {
      const m = await import(/* @vite-ignore */ '/src/shell/modules.ts');
      return (m.MODULES as { id: string; label: string }[]).map((x) => ({
        id: x.id,
        label: x.label,
      }));
    });
    expect(modules.length).toBeGreaterThan(30);

    const failures: string[] = [];
    for (const m of modules) {
      // Skip the chart itself: it is the base window of the layout, not a module window.
      if (m.id === 'chart') continue;
      const groups = await page.locator('.dv-groupview').count();
      await page.getByTestId(`ribbon-${m.id}`).click({ timeout: 5000 });
      let opened = await page
        .waitForFunction((n) => document.querySelectorAll('.dv-groupview').length > n, groups, {
          timeout: 1200,
        })
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        // The button only opened its ▾ menu (or opened the window as a tab): use the palette command.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+k');
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await palette
          .getByPlaceholder('Search commands, symbols, layouts…')
          .fill(`Open ${m.label}`);
        await page.keyboard.press('Enter');
        opened = true;
      }
      await page.waitForTimeout(700);
      const findings = await page.evaluate(audit, ACTIVE_WINDOW);
      for (const f of findings) failures.push(`${m.id}: ${f.kind} ${f.detail}`);
      // Close the window again so the next module gets the same space.
      await page.keyboard.press('Escape');
      const close = page
        .locator(`.dv-groupview.dv-active-group [aria-label="Close window"]`)
        .first();
      if (await close.isVisible().catch(() => false))
        await close.click({ timeout: 3000 }).catch(() => failures.push(`${m.id}: could not close`));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    expect(failures, failures.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Indicators dialog, Trading Panel and shell stay usable at ${tag}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await createAccount(page, `smallb-${tag}`);
    await page.waitForTimeout(1000);
    const failures: string[] = [];
    const note = (what: string, f: Finding[]) =>
      f.forEach((x) => failures.push(`${what}: ${x.kind} ${x.detail}`));

    // Shell: the page itself never scrolls sideways; sidebar and bars fit.
    const pageScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (pageScroll > 1) failures.push(`page scrolls sideways by ${pageScroll}px`);
    note('trading-panel', await page.evaluate(audit, '[data-testid="trading-panel"]'));
    note('ribbon', await page.evaluate(audit, 'nav.ribbon'));

    // Indicators dialog (every category list, the last footer button).
    await page.getByTestId('indicators-button').first().click();
    await expect(page.getByTestId('indicators-dialog')).toBeVisible();
    await page.waitForTimeout(400);
    note('indicators dialog', await page.evaluate(audit, '[data-testid="indicators-dialog"]'));
    const dlgBox = await page.getByTestId('indicators-dialog').boundingBox();
    if (!dlgBox || dlgBox.y < -1 || dlgBox.y + dlgBox.height > size.height + 1)
      failures.push(`indicators dialog leaves the screen: ${JSON.stringify(dlgBox)}`);
    await expect(page.getByTestId('indicators-apply')).toBeInViewport();
    await page.keyboard.press('Escape');

    expect(failures, failures.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  });
}
