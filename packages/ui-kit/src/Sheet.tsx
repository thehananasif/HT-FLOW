import * as RxDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  side?: 'right' | 'left' | 'bottom';
  /** Width (left/right) or height (bottom) in px. */
  size?: number;
  children: ReactNode;
  footer?: ReactNode;
}

/** Side drawer built on Radix Dialog (focus trap, Esc to close, restores focus). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  side = 'right',
  size = 380,
  children,
  footer,
}: SheetProps) {
  const style = side === 'bottom' ? { height: size } : { width: size };
  return (
    <RxDialog.Root open={open} onOpenChange={onOpenChange}>
      <RxDialog.Portal>
        <RxDialog.Overlay className="ht-scrim" />
        <RxDialog.Content className={`ht-sheet ht-sheet--${side}`} style={style}>
          <header className="ht-sheet-head">
            <RxDialog.Title className="ht-sheet-title">{title}</RxDialog.Title>
            <RxDialog.Close className="ht-icon-btn" aria-label="Close">
              <X size={14} />
            </RxDialog.Close>
          </header>
          <RxDialog.Description className={description ? 'ht-dialog-desc ht-sheet-desc' : undefined} style={description ? undefined : { display: 'none' }}>
            {description ?? title}
          </RxDialog.Description>
          <div className="ht-sheet-body">{children}</div>
          {footer && <footer className="ht-sheet-foot">{footer}</footer>}
        </RxDialog.Content>
      </RxDialog.Portal>
    </RxDialog.Root>
  );
}
