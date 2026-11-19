/** Renders docs/MANUAL-TEST-CHECKLIST.md from the live registries (modules, commands, settings). */
export function manualChecklist(
  modules: { id: string; label: string; group: string }[],
  commands: { id: string; label: string; group: string }[],
  sections: { id: string; label: string }[],
): string {
  const box = (s: string) => `- [ ] ${s}`;
  const groups = [...new Set(modules.map((m) => m.group))];
  const cmdGroups = [...new Set(commands.map((c) => c.group))].sort();
  // Instrument switches are one handler per symbol: list the count, not hundreds of lines.
  const inst = commands.filter((c) => c.group === 'Instrument');
  const out: string[] = [
    '# Manual test checklist (Windows, installed build)',
    '',
    '> Generated from the module, command and settings registries by',
    '> `WRITE_CHECKLIST=1 pnpm e2e:clickall -g registry` — do not edit by hand; regenerate after',
    '> adding a module or command. Print it, tick each box on a real Windows PC with the installed',
    '> release candidate, and note anything odd next to the box. See docs/RELEASE.md → Release checklist.',
    '',
    'Tester: ____________________  Build / version: ____________  Windows version: ____________  Date: __________',
    '',
    '## 0. Install and start',
    '',
    box('Installer runs (per-user), no SmartScreen surprise beyond the known unsigned warning'),
    box('App starts, login screen shows the animated background, no error toast'),
    box('Create account (with a 6-digit PIN), save the recovery code, dashboard opens'),
    box('Lock (Ctrl+L), unlock with PIN; log out, log in with the password'),
    box('Title bar: drag, minimise, maximise / restore, close asks to confirm and exits cleanly'),
    box('Double-click a .htstrat / workspace file in Explorer: HT Flow opens it'),
    box('Uninstall keeps / removes user data as chosen'),
    '',
    '## 1. Ribbon modules',
    '',
    'For each: open it from the ribbon, click every button / tab / menu in the window, resize the',
    'window small and large (nothing cut off or overlapping), detach it to its own OS window and',
    're-attach, close it.',
    '',
  ];
  for (const g of groups) {
    out.push(`### ${g}`, '');
    for (const m of modules.filter((x) => x.group === g)) out.push(box(`${m.label} (\`${m.id}\`)`));
    out.push('');
  }
  out.push(
    '## 2. Chart',
    '',
    box('Chart toolbar: every button, interval menu, chart type menu, indicators, templates'),
    box('Side tools: every drawing tool draws, edits, deletes'),
    box(
      'Right-click menu: every item (Buy/Sell limit at, alerts, Settings…, Go to date…, detach…)',
    ),
    box('Mouse wheel zoom, drag pan, price-axis drag scale, double-click resets'),
    '',
    '## 3. Settings sections',
    '',
  );
  for (const s of sections) out.push(box(`${s.label} — change one value, restart, value kept`));
  out.push('', '## 4. Command Palette (Ctrl+K)', '');
  for (const g of cmdGroups) {
    if (g === 'Instrument') continue;
    out.push(`### ${g}`, '');
    for (const c of commands
      .filter((x) => x.group === g)
      .sort((a, b) => a.label.localeCompare(b.label)))
      out.push(box(`${c.label} (\`${c.id}\`)`));
    out.push('');
  }
  if (inst.length)
    out.push(
      '### Instrument',
      '',
      box(
        `Switch the active window to 3 different symbols (${inst.length} instrument commands registered)`,
      ),
      '',
    );
  out.push(
    '## 5. Native features',
    '',
    box('Settings → Logs → Open log folder opens Explorer'),
    box('Settings → Common → Back up now, then Open backups folder'),
    box(
      'Connections: Binance / Bybit symbol discovery returns symbols (or a clear region-blocked message)',
    ),
    box('COT, News, Calendar load (or show a clear offline state)'),
    box('HT Editor: run a backtest; optimise; paper run'),
    box('AI: add a provider key, list models, ask a question (optional: needs your own key)'),
    box('Web Pages window loads a site; opens in its own OS window'),
    box('Auto-update check (Settings → About) reports up to date'),
    '',
  );
  return out.join('\n');
}
