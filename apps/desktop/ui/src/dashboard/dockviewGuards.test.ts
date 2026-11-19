import { DockviewGroupPanelModel } from 'dockview';
import { describe, expect, it, vi } from 'vitest';
import { installDockviewGuards } from './dockviewGuards';

describe('dockview guards', () => {
  it('removing a panel that is not in the group touches nothing', () => {
    installDockviewGuards();
    const proto = DockviewGroupPanelModel.prototype as unknown as {
      doRemovePanel(this: unknown, panel: unknown): void;
    };
    const del = vi.fn();
    const fake = { panels: [{ id: 'a' }], tabsContainer: { delete: del }, _activePanel: null };
    proto.doRemovePanel.call(fake, { id: 'gone' });
    expect(del).not.toHaveBeenCalled();
  });
});
