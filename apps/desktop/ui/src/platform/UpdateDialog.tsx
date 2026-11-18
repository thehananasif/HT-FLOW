import { Button, Dialog } from '@htflow/ui-kit';
import { checkForUpdates, currentChannel, installUpdate, useUpdates } from './updates';

import { translateLiteral as tl } from '@htflow/i18n';
/** "Check for updates" dialog (Command Palette / Settings → About). */
export function UpdateDialog() {
  const { open, phase, message, notes, hide } = useUpdates();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? undefined : hide())}
      title={tl('Check for updates')}
      description={`Channel: ${currentChannel()}. Updates are downloaded from GitHub Releases and verified with a signature before they are installed.`}
      width={460}
    >
      <div className="col gap12" data-testid="update-dialog" data-phase={phase}>
        <p className="crash-note" role="status" data-testid="update-message">
          {message}
        </p>
        {phase === 'available' && notes && <pre className="upd-notes">{notes}</pre>}
        <div className="row gap8">
          {phase === 'available' && (
            <Button variant="primary" onClick={() => void installUpdate()}>
              {tl('Install and restart')}
            </Button>
          )}
          {(phase === 'uptodate' || phase === 'error') && (
            <Button onClick={() => void checkForUpdates()}>{tl('Check again')}</Button>
          )}
          <Button onClick={hide} disabled={phase === 'installing'}>
            {tl('Close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
