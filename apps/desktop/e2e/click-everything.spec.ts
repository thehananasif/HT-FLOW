/**
 * "Click everything" crawl of the web build (runs in the Windows CI job with `pnpm e2e`; alone with
 * `pnpm e2e:clickall`). Every ribbon module (enumerated from the module registry), the title bar,
 * status bar, trading panel, chart window toolbar, side tools, chart context menu, every Settings
 * section and every Command Palette command (enumerated from the command registry) is exercised;
 * see e2e/clickall/core.ts for what is checked after each click. Report:
 * apps/desktop/test-results/click-report/index.html (+ report.json, screenshots).
 *
 * Shard-friendly: one test per module chunk / command slice, and the file runs in parallel mode,
 * so `playwright test --shard=1/3` splits it across machines.
 */
import { expect, test, type Page } from '@playwright/test';
import { crawlSurface, failuresOf, runCommands, takeErrors, type Driver } from './clickall/core';
import { isDestructiveCommand, UNDO_AFTER } from './clickall/policy';
import { writePart, type ReportPart } from './clickall/report';
import { createAccount, installProbe, playwrightDriver, REPORT_DIR } from './clickall/playwright';

interface ModuleInfo {
  id: string;
  label: string;
  group: string;
  built: boolean;
  hasMenu: boolean;
}
interface CommandInfo {
  id: string;
  label: string;
  group: string;
}

/** Ribbon groups (ModuleDef['group']) and how many tests each is split into. */
const GROUPS: [string, number][] = [
  ['Analysis', 3],
  ['Platform', 2],
  ['Social / Tools', 2],
  ['Tables', 2],
  ['Market Analytics', 1],
  ['Info', 1],
];
const COMMAND_SLICES = 4;
/** Prefixes with many near-identical commands: a sample is run, the rest are covered by the sample. */
const SAMPLED: [RegExp, number][] = [
  [/^inst\./, 4],
  [/^chart\./, 6],
  [/^tf\./, 6],
  [/^dom\.open\./, 3],
];

const intro = <T>(page: Page, expr: string) =>
  page.evaluate(`window.__HTFLOW_INTROSPECT__.${expr}`) as Promise<T>;

async function boot(page: Page, user: string): Promise<Driver> {
  await installProbe(page);
  await createAccount(page, user);
  const d = playwrightDriver(page);
  // Let the start-up layout settle, then start from a clean error slate (start-up errors still fail).
  await page.waitForTimeout(400);
  return d;
}

async function resetLayout(page: Page) {
  await intro(page, `runCommand('layout.single')`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

function finish(part: ReportPart) {
  writePart(REPORT_DIR, part);
  const failures = [
    ...part.surfaces.flatMap(failuresOf),
    ...(part.commands ?? [])
      .filter((s) => s.status === 'fail')
      .map((s) => `${s.surface} › ${s.control}: ${s.notes.join(' | ')}`),
  ];
  expect(failures, 'click-everything failures (see test-results/click-report)').toEqual([]);
}

test.describe('click everything', { tag: '@clickall' }, () => {
  test.describe.configure({ mode: 'parallel' });
  test.setTimeout(420_000);

  test('registry: every ribbon module belongs to a crawled group', async ({ page }) => {
    await boot(page, 'clkreg');
    const mods = await intro<ModuleInfo[]>(page, 'modules()');
    expect(mods.length).toBeGreaterThan(20);
    const known = new Set(GROUPS.map(([g]) => g));
    expect(mods.filter((m) => !known.has(m.group)).map((m) => m.id)).toEqual([]);
    const cmds = await intro<CommandInfo[]>(page, 'commands()');
    // Every ribbon module has an "Open" command in the palette.
    const ids = new Set(cmds.map((c) => c.id));
    expect(mods.filter((m) => !ids.has(`open.${m.id}`)).map((m) => m.id)).toEqual([]);
  });

  test('shell: title bar, ribbon, status bar, trading panel, side tools, chart', async ({
    page,
  }) => {
    const d = await boot(page, 'clkshell');
    const part: ReportPart = { name: 'shell', runner: 'playwright-web', surfaces: [] };
    part.surfaces.push(await crawlSurface(d, 'Title bar', 'Shell', '.titlebar'));
    part.surfaces.push(await crawlSurface(d, 'Status bar', 'Shell', '.statusbar'));
    await resetLayout(page);
    // Ribbon: every module button (menus get their first entry picked).
    part.surfaces.push(
      await crawlSurface(d, 'Ribbon', 'Shell', 'nav.ribbon', {
        maxControls: 200,
        budgetMs: 150_000,
        // The layout fills with windows; start every few buttons from a single chart again.
      }),
    );
    await resetLayout(page);
    await intro(page, `runCommand('layout.dom-chart-panel')`);
    await page.waitForTimeout(500);
    part.surfaces.push(
      await crawlSurface(d, 'Trading panel', 'Shell', '[data-testid="trading-panel"]'),
    );
    await resetLayout(page);
    part.surfaces.push(await crawlSurface(d, 'Side tools', 'Chart', '[data-testid="sidetools"]'));
    await resetLayout(page);
    const chartRoot = '.dv-groupview:has([data-window-id])';
    part.surfaces.push(
      await crawlSurface(d, 'Chart window (toolbar + panes)', 'Chart', chartRoot, {
        reopen: () => resetLayout(page),
        maxControls: 120,
      }),
    );
    finish(part);
  });

  test('chart: every context-menu item', async ({ page }) => {
    const d = await boot(page, 'clkctx');
    await resetLayout(page);
    const host = page.locator('[data-testid^="chart-"]:has(canvas)').first();
    await expect(host.locator('canvas').first()).toBeVisible();
    const open = async () => {
      // An item may change the chart (mode, drawing tool): fall back to a fresh single chart.
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.keyboard.press('Escape');
        const box = await host.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + 150, { button: 'right' });
          const ok = await page
            .getByRole('menuitem')
            .first()
            .waitFor({ timeout: 2000 })
            .then(() => true, () => false);
          if (ok) return;
        }
        await resetLayout(page);
      }
      await expect(page.getByRole('menuitem').first()).toBeVisible();
    };
    await open();
    const labels = await page.getByRole('menuitem').allInnerTexts();
    expect(labels.length).toBeGreaterThan(10);
    const surface = await crawlSurface(d, 'Chart context menu', 'Chart', '[role="menu"]', {
      reopen: open,
      maxControls: 120,
      budgetMs: 240_000,
    });
    finish({ name: 'chart-context-menu', runner: 'playwright-web', surfaces: [surface] });
  });

  for (const [group, chunks] of GROUPS) {
    for (let chunk = 0; chunk < chunks; chunk++) {
      test(`modules: ${group} (${chunk + 1}/${chunks})`, async ({ page }) => {
        const d = await boot(page, `clk${group.replace(/\W/g, '').toLowerCase()}${chunk}`);
        const mods = (await intro<ModuleInfo[]>(page, 'modules()')).filter(
          (m) => m.group === group,
        );
        const mine = mods.filter((_, i) => i % chunks === chunk);
        const part: ReportPart = {
          name: `modules-${group}-${chunk}`,
          runner: 'playwright-web',
          surfaces: [],
        };
        for (const m of mine) {
          await resetLayout(page);
          await takeErrors(d);
          const openIt = async () => {
            await intro(page, `runCommand(${JSON.stringify(`open.${m.id}`)})`);
            await page.waitForTimeout(400);
          };
          await openIt();
          part.surfaces.push(
            await crawlSurface(d, `${m.label} (${m.id})`, group, 'active-panel', {
              reopen: async () => {
                await resetLayout(page);
                await openIt();
              },
            }),
          );
        }
        finish(part);
      });
    }
  }

  test('settings: every section', async ({ page }) => {
    const d = await boot(page, 'clksettings');
    const sections = await intro<{ id: string; label: string }[]>(page, 'settingsSections()');
    expect(sections.length).toBeGreaterThan(10);
    const part: ReportPart = { name: 'settings', runner: 'playwright-web', surfaces: [] };
    await resetLayout(page);
    const openSettings = async () => {
      await intro(page, `runCommand('settings.open')`);
      await expect(page.getByTestId('settings-window')).toBeVisible();
    };
    await openSettings();
    for (const s of sections) {
      const nav = page.locator('.st-nav-item', { hasText: s.label }).first();
      if (!(await nav.isVisible())) await openSettings();
      await nav.click();
      await page.waitForTimeout(150);
      part.surfaces.push(
        await crawlSurface(d, s.label, 'Settings', '[data-testid="settings-window"] .st-main', {
          maxControls: 60,
          budgetMs: 45_000,
          // Language switch remounts the UI (own spec: urdu-rtl); backup / logs folders are native.
          skip: [/^language$/i, /^زبان$/],
          reopen: async () => {
            await openSettings();
            await page.locator('.st-nav-item', { hasText: s.label }).first().click();
          },
        }),
      );
    }
    finish(part);
  });

  for (let slice = 0; slice < COMMAND_SLICES; slice++) {
    test(`command palette: commands ${slice + 1}/${COMMAND_SLICES}`, async ({ page }) => {
      const d = await boot(page, `clkcmd${slice}`);
      const all = await intro<CommandInfo[]>(page, 'commands()');
      expect(all.length).toBeGreaterThan(100);
      const taken = new Map<RegExp, number>();
      const picked: CommandInfo[] = [];
      const sampledOut: CommandInfo[] = [];
      for (const c of [...all].sort((a, b) => a.id.localeCompare(b.id))) {
        if (isDestructiveCommand(c.id, c.label)) continue;
        const s = SAMPLED.find(([re]) => re.test(c.id));
        if (s) {
          const n = taken.get(s[0]) ?? 0;
          taken.set(s[0], n + 1);
          if (n >= s[1]) {
            sampledOut.push(c);
            continue;
          }
        }
        picked.push(c);
      }
      const mine = picked.filter((_, i) => i % COMMAND_SLICES === slice);
      const steps = [];
      // Small batches with a layout reset in between, so windows do not pile up.
      for (let i = 0; i < mine.length; i += 12) {
        await resetLayout(page);
        await takeErrors(d);
        const batch = mine.slice(i, i + 12);
        steps.push(...(await runCommands(d, batch)));
        for (const c of batch) if (UNDO_AFTER[c.id]) await runCommands(d, [{ id: UNDO_AFTER[c.id]!, label: 'undo' }]);
      }
      if (slice === 0)
        for (const c of sampledOut)
          steps.push({
            surface: 'Command Palette',
            control: `${c.label} (${c.id})`,
            role: 'command',
            status: 'skip' as const,
            effect: '',
            notes: ['same handler as the sampled commands of this family'],
          });
      finish({ name: `commands-${slice}`, runner: 'playwright-web', surfaces: [], commands: steps });
    });
  }

  test('command palette: destructive commands, last, in a fresh context', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let n = 0;
    let d = await boot(page, `clkdestroy${n}`);
    const all = (await intro<CommandInfo[]>(page, 'commands()')).filter((c) =>
      isDestructiveCommand(c.id, c.label),
    );
    const steps = [];
    for (const c of all) {
      // A command may end the session (log out, lock, reset): sign in again with a new account.
      if (!(await page.getByTestId('app-heartbeat').count())) {
        await ctx.clearCookies();
        d = await boot(page, `clkdestroy${++n}`);
      }
      steps.push(...(await runCommands(d, [c])));
      await page.waitForTimeout(150);
    }
    await ctx.close();
    finish({ name: 'commands-destructive', runner: 'playwright-web', surfaces: [], commands: steps });
  });
});
