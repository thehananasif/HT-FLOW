import { useEffect, useState } from 'react';
import { Toaster, TooltipProvider } from '@htflow/ui-kit';
import { backend } from './backend';
import { useSession } from './state/session';
import { LoginScreen } from './auth/LoginScreen';
import { Dashboard } from './dashboard/Dashboard';
import { Gallery } from './Gallery';

export function App() {
  const session = useSession((s) => s.session);
  const [version, setVersion] = useState('');
  useEffect(() => void backend.appVersion().then(setVersion), []);
  const gallery = import.meta.env.DEV && new URLSearchParams(location.search).has('gallery');
  return (
    <TooltipProvider>
      {gallery ? <Gallery /> : session ? <Dashboard version={version} /> : <LoginScreen />}
      <Toaster />
    </TooltipProvider>
  );
}
