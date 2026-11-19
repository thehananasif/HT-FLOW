import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Checkbox, Dialog } from '@htflow/ui-kit';
import { setPrefs, tradingPrefs, type ConfirmKind } from './prefs';

import { translateLiteral as tl } from '@htflow/i18n';
interface Pending {
  kind: ConfirmKind;
  title: string;
  lines: string[];
  resolve(ok: boolean): void;
}

let show: ((p: Pending | null) => void) | null = null;
let queue: Pending[] = [];

function Host() {
  const [cur, setCur] = useState<Pending | null>(null);
  const [skip, setSkip] = useState(false);
  useEffect(() => {
    show = (p) => {
      setSkip(false);
      setCur(p);
    };
    return () => {
      show = null;
    };
  }, []);
  const close = (ok: boolean) => {
    if (!cur) return;
    if (ok && skip) setPrefs({ confirm: { ...tradingPrefs.get().confirm, [cur.kind]: false } });
    cur.resolve(ok);
    queue = queue.slice(1);
    setCur(queue[0] ?? null);
  };
  return (
    <Dialog
      open={!!cur}
      onOpenChange={(o) => !o && close(false)}
      title={cur?.title ?? 'Confirm'}
      width={360}
    >
      {cur && (
        <div className="ot-confirm" data-testid="order-confirm">
          <ul className="ot-confirm-lines tnum">
            {cur.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <Checkbox checked={skip} onChange={setSkip} label={tl("Don't ask again for this type")} />
          <div className="row gap8 ot-confirm-actions">
            <Button onClick={() => close(false)}>{tl('Cancel')}</Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => close(true)}
              data-testid="confirm-ok"
            >
              {tl('Confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function mount(): void {
  if (show || typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.id = 'ht-order-confirm-root';
  document.body.appendChild(el);
  createRoot(el).render(<Host />);
}

/**
 * Asks the user to confirm an action when the per-order-type confirmation is on (Settings →
 * Order confirmations). Resolves true immediately when confirmations are off for `kind`.
 */
export function confirmAction(
  kind: ConfirmKind,
  title: string,
  lines: string[],
  /** Ask even when this order type's confirmation is off (Settings → confirm orders / one-click off). */
  force = false,
): Promise<boolean> {
  if (!force && !tradingPrefs.get().confirm[kind]) return Promise.resolve(true);
  mount();
  return new Promise((resolve) => {
    const p: Pending = { kind, title, lines, resolve };
    queue.push(p);
    const tryShow = () => {
      if (show) {
        if (queue[0] === p) show(p);
      } else setTimeout(tryShow, 16);
    };
    tryShow();
  });
}
