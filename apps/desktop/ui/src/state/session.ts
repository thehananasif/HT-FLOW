import { create } from 'zustand';
import { applyTheme, type ThemeName } from '@htflow/ui-kit';
import { backend, type SessionInfo } from '../backend';

interface SessionState {
  session: SessionInfo | null;
  locked: boolean;
  /** Username to show on the lock screen. */
  lastUser: string | null;
  setSession(s: SessionInfo | null): void;
  lock(): Promise<void>;
  logout(): Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  session: null,
  locked: false,
  lastUser: null,
  setSession: (s) => {
    if (s) applyTheme((s.theme as ThemeName) || 'dark');
    set({ session: s, locked: false, lastUser: s?.username ?? get().lastUser });
  },
  lock: async () => {
    await backend.lock();
    set({ locked: true, session: null });
  },
  logout: async () => {
    await backend.logout();
    set({ session: null, locked: false });
  },
}));
