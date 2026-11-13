import { create } from 'zustand';
import { registerCommands, runCommand } from '../../../shell/commands';

/** Open state of the CSV import dialog (so a command or the Connections wizard can open it). */
interface ImportUi {
  open: boolean;
  show(): void;
  hide(): void;
}

export const useCsvImportUi = create<ImportUi>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

export function openCsvImport(): void {
  useCsvImportUi.getState().show();
}

registerCommands([
  {
    id: 'data.import-csv',
    label: 'Import CSV: trades or OHLCV bars…',
    group: 'Platform',
    keywords: 'data manager history replay file comma delimited column mapping tick bars ohlcv',
    run: () => {
      runCommand('open.data-manager');
      openCsvImport();
    },
  },
]);
