import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Button, Dialog } from '@htflow/ui-kit';
import { backend } from '../backend';
import { BrandIcon, BrandLogo } from '../components/Brand';
import { ABOUT_LINKS } from '../modules/settings/licenses';
import { useReportDialog } from './crash';
import { checkForUpdates } from './updates';

import { translateLiteral as tl } from '@htflow/i18n';
export const useAbout = create<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

/** "About HT Flow": product name, version, the owner's brand logo and links. */
export function AboutDialog() {
  const { open, hide } = useAbout();
  const [version, setVersion] = useState('');
  useEffect(() => {
    if (open)
      void backend
        .appVersion()
        .then(setVersion)
        .catch(() => setVersion('unknown'));
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? undefined : hide())}
      title={tl('About HT Flow')}
      description={tl('Order-flow trading platform. Local-first, MIT licence.')}
      width={460}
    >
      <div className="col gap12 about-dlg" data-testid="about-dialog">
        <div className="about-brand">
          <BrandLogo height={170} testId="about-logo" />
          <div className="row gap8 center-y">
            <BrandIcon size={28} />
            <div>
              <b>{tl('HT Flow')}</b> <span className="muted">v{version}</span>
              <div className="muted" style={{ fontSize: 11 }}>
                {tl('Logo and brand: HANAN TRADE')}
              </div>
            </div>
          </div>
        </div>
        <div className="row gap12 wrap">
          {ABOUT_LINKS.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          ))}
        </div>
        <div className="row gap8">
          <Button size="sm" onClick={() => void checkForUpdates()}>
            {tl('Check for updates')}
          </Button>
          <Button size="sm" onClick={() => useReportDialog.getState().show()}>
            {tl('Report a problem…')}
          </Button>
          <Button size="sm" onClick={hide}>
            {tl('Close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
