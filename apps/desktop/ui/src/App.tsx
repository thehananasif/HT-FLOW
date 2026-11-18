import { useEffect, useState } from 'react';
import { Toaster, TooltipProvider } from '@htflow/ui-kit';
import { backend } from './backend';
import { useSession } from './state/session';
import { LoginScreen } from './auth/LoginScreen';
import { Dashboard } from './dashboard/Dashboard';
import { Gallery } from './Gallery';
import { PlatformHost } from './platform/PlatformHost';
import { SecondaryApp } from './platform/SecondaryApp';
import { secondaryLabel } from './platform/secondary';

/** Set once: a secondary OS window (`?window=ht-w-…`) never shows the login or the main chrome. */
const osWindowLabel = secondaryLabel();

export function App() {
  const session = useSession((s) => s.session);
  const [version, setVersion] = useState('');
  useEffect(() => void backend.appVersion().then(setVersion), []);
  const gallery = import.meta.env.DEV && new URLSearchParams(location.search).has('gallery');
  return (
    <TooltipProvider>
      {osWindowLabel ? (
        <SecondaryApp label={osWindowLabel} />
      ) : gallery ? (
        <Gallery />
      ) : session ? (
        <Dashboard version={version} />
      ) : (
        <LoginScreen />
      )}
      <PlatformHost secondary={!!osWindowLabel} />
      <Toaster />
    </TooltipProvider>
  );
}
