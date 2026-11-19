import { DockviewGroupPanelModel } from 'dockview';

/**
 * dockview removes a panel from a group by index: asked to remove a panel that is no longer in the
 * group (index -1), it deletes the group's *last* tab instead. That leaves another panel without a
 * tab, and the next removal of that panel throws ("Cannot destructure property 'value'"), which
 * broke Float / dock and Load workspace after windows moved to and from separate OS windows.
 * Removing a panel that is not in the group is made a no-op, so the layout is never corrupted.
 */
interface GroupModelLike {
  panels: readonly unknown[];
  doRemovePanel(panel: unknown): void;
}

let installed = false;

export function installDockviewGuards(): void {
  if (installed) return;
  installed = true;
  const proto = DockviewGroupPanelModel.prototype as unknown as GroupModelLike;
  const original = proto.doRemovePanel;
  if (typeof original !== 'function') return;
  proto.doRemovePanel = function (this: GroupModelLike, panel: unknown) {
    if (!this.panels.includes(panel)) return;
    original.call(this, panel);
  };
}
