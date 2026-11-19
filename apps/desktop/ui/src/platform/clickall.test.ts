import { describe, expect, it } from 'vitest';
import { isBenign, isDestructive, isDestructiveCommand } from '../../../e2e/clickall/policy';
import { buildReport, renderHtml, type ReportPart } from '../../../e2e/clickall/report';
import { manualChecklist } from '../../../e2e/clickall/checklist';

describe('click-everything policy', () => {
  it('skips destructive controls and window chrome, keeps ordinary ones', () => {
    for (const l of ['Delete profile', 'Reset all settings', 'Log out', 'Lock', 'Close all', '×'])
      expect(isDestructive(l), l).toBe(true);
    expect(isDestructive('', 'privacy-reset-all')).toBe(true);
    for (const l of ['Apply', 'Buy', 'Settings…', 'Clock', 'Add indicator', 'Closed trades'])
      expect(isDestructive(l), l).toBe(false);
  });
  it('flags destructive commands by id or label', () => {
    expect(isDestructiveCommand('lock', 'Lock HT Flow')).toBe(true);
    expect(isDestructiveCommand('settings.resetAll', 'Settings: Reset all')).toBe(true);
    expect(isDestructiveCommand('open.chart', 'Open Chart')).toBe(false);
  });
  it('only allow-lists known benign console noise', () => {
    expect(isBenign('Download the React DevTools for a better development experience')).toBe(true);
    expect(isBenign('TypeError: x is undefined')).toBe(false);
  });
});

describe('click-everything report', () => {
  const part: ReportPart = {
    name: 'p',
    runner: 't',
    surfaces: [
      {
        name: 'Win',
        group: 'G',
        controls: 2,
        durationMs: 5,
        errors: [],
        layout: { overflow: ['div.x (0..900 of 800px)'], overlap: [] },
        steps: [
          { surface: 'Win', control: 'A', role: 'button', status: 'pass', effect: 'x', notes: [] },
          {
            surface: 'Win',
            control: '<B>',
            role: 'button',
            status: 'fail',
            effect: '',
            notes: ['boom'],
          },
        ],
      },
    ],
    commands: [
      {
        surface: 'Command Palette',
        control: 'c',
        role: 'command',
        status: 'warn',
        effect: '',
        notes: [],
      },
    ],
  };
  it('totals steps and lists failures including layout issues', () => {
    const r = buildReport([part], 'test');
    expect(r.totals).toMatchObject({ controls: 3, pass: 1, fail: 1, warn: 1, skip: 0 });
    expect(r.failures).toHaveLength(2);
    expect(r.fixedBugs.length).toBeGreaterThan(0);
  });
  it('escapes control labels in the HTML', () => {
    const html = renderHtml(buildReport([part], 'test'));
    expect(html).toContain('&lt;B&gt;');
    expect(html).not.toContain('<B>');
  });
  it('renders a checklist entry per module, settings section and command', () => {
    const md = manualChecklist(
      [{ id: 'chart', label: 'Chart', group: 'Analysis' }],
      [
        { id: 'open.chart', label: 'Open Chart', group: 'Analysis' },
        { id: 'inst.a', label: 'A', group: 'Instrument' },
      ],
      [{ id: 'general', label: 'General' }],
    );
    expect(md).toContain('- [ ] Chart (`chart`)');
    expect(md).toContain('- [ ] Open Chart (`open.chart`)');
    expect(md).toContain('General');
    expect(md).toContain('1 instrument commands');
  });
});
