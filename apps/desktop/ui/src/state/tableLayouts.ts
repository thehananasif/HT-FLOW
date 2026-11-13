/**
 * Persists ui-kit table column layouts (order + widths per table id) in the user's settings
 * (`common.tableLayouts`), so they follow the profile and are exported with the settings.
 */
import {
  notifyTableLayouts,
  sanitizeLayout,
  setTableLayoutAdapter,
  type ColumnLayout,
} from '@htflow/ui-kit';
import { registerCommands } from '../shell/commands';
import { getSetting, onSettingChange, setSetting } from './settings';

let installed = false;

export function installTableLayouts(): void {
  if (installed) return;
  installed = true;
  setTableLayoutAdapter({
    get: (id) => {
      const l = getSetting('common.tableLayouts')[id];
      return l ? sanitizeLayout(l) : undefined;
    },
    set: (id, layout: ColumnLayout | null) => {
      const cur = { ...getSetting('common.tableLayouts') };
      if (layout) cur[id] = layout;
      else delete cur[id];
      setSetting('common.tableLayouts', cur);
    },
  });
  onSettingChange('common.tableLayouts', () => notifyTableLayouts());
  registerCommands([
    {
      id: 'tables.resetLayouts',
      label: 'Tables: Reset all column widths and order',
      group: 'Tables',
      keywords: 'column resize reorder table layout',
      run: () => setSetting('common.tableLayouts', {}),
    },
  ]);
}

installTableLayouts();
