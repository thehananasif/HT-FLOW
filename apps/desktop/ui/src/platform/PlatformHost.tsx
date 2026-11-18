import { useEffect } from 'react';
import { useSession } from '../state/session';
import { registerCommands } from '../shell/commands';
import { installGlobalCrashHandlers, useReportDialog } from './crash';
import { flushWaitingFiles, startOpenFileBridge } from './openFile';
import { ReportProblemDialog } from './ReportProblem';
import { UpdateDialog } from './UpdateDialog';
import { checkForUpdates, startupUpdateCheck } from './updates';
import './styles.css';

registerCommands([
  {
    id: 'platform.checkUpdates',
    label: 'Check for updates',
    group: 'Platform',
    keywords: 'update upgrade new version release download',
    run: () => void checkForUpdates(),
  },
  {
    id: 'platform.reportProblem',
    label: 'Report a problem…',
    group: 'Platform',
    keywords: 'bug crash error log feedback issue support',
    run: () => useReportDialog.getState().show(),
  },
]);

/** Mounts the platform dialogs and wires file-open events, crash handlers and the update check. */
export function PlatformHost({ secondary = false }: { secondary?: boolean }) {
  const loggedIn = useSession((s) => !!s.session);

  useEffect(() => {
    installGlobalCrashHandlers();
    // Files opened from Explorer and the update check belong to the main window only.
    if (secondary) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void startOpenFileBridge().then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [secondary]);

  useEffect(() => {
    if (!loggedIn || secondary) return;
    void flushWaitingFiles();
    startupUpdateCheck();
  }, [loggedIn, secondary]);

  return (
    <>
      <ReportProblemDialog />
      <UpdateDialog />
    </>
  );
}
