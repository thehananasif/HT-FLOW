import { Button, Dialog } from '@htflow/ui-kit';
import { useConfirmStore } from '../../state/confirm';

import { translateLiteral as tl } from '@htflow/i18n';
/** Renders the oldest pending confirmation (state/confirm.ts). Mounted once by the Settings module. */
export function ConfirmHost() {
  const req = useConfirmStore((s) => s.queue[0]);
  if (!req) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && req.resolve(false)} title={req.title} width={380}>
      <p className="st-confirm-body" data-testid="confirm-body">
        {req.body}
      </p>
      <div className="row gap8 st-confirm-actions">
        <div className="grow" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="confirm-cancel"
          onClick={() => req.resolve(false)}
        >
          {tl('Cancel')}
        </Button>
        <Button
          size="sm"
          variant={req.danger ? 'destructive' : 'primary'}
          data-testid="confirm-ok"
          autoFocus
          onClick={() => req.resolve(true)}
        >
          {req.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
