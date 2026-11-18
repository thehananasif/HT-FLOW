import { useEffect } from 'react';
import { useSession } from '../state/session';
import { registerCommands } from '../shell/commands';
import { installGlobalCrashHandlers, useReportDialog } from './crash';
import { flushWaitingFiles, startOpenFileBridge } from './openFile';
import { runBackupNow, runOpenBackupsFolder, runOpenLogFolder } from './nativeOps';
import { ReportProblemDialog } from './ReportProblem';
import { UpdateDialog } from './UpdateDialog';
import { AboutDialog, useAbout } from './AboutDialog';
import { checkForUpdates, startupUpdateCheck } from './updates';
import './styles.css';

registerCommands([
  {
    id: 'platform.about',
    label: 'About HT Flow',
    group: 'Platform',
    keywords: 'version licence license logo brand hanan trade info',
    run: () => useAbout.getState().show(),
  },
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
  {
    id: 'platform.openLogFolder',
    label: 'Open log folder',
    group: 'Platform',
    keywords: 'logs files explorer diagnostics',
    run: () => void runOpenLogFolder(),
  },
  {
    id: 'platform.backupNow',
    label: 'Back up profile now',
    group: 'Platform',
    keywords: 'backup copy profile settings save snapshot',
    run: () => void runBackupNow(),
  },
  {
    id: 'platform.openBackupsFolder',
    label: 'Open backups folder',
    group: 'Platform',
    keywords: 'backup backups explorer restore',
    run: () => void runOpenBackupsFolder(),
  },
]);

/** Mounts the platform dialogs and wires file-open events, crash handlers and the update check. */
export function PlatformHost() {
  const loggedIn = useSession((s) => !!s.session);

  useEffect(() => {
    installGlobalCrashHandlers();
    let off: (() => void) | undefined;
    let cancelled = false;
    void startOpenFileBridge().then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    void flushWaitingFiles();
    startupUpdateCheck();
  }, [loggedIn]);

  return (
    <>
      <ReportProblemDialog />
      <UpdateDialog />
      <AboutDialog />
    </>
  );
}
