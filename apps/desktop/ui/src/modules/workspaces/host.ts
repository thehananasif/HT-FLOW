/**
 * Bridge between the Workspaces manager and the Dashboard (which owns dockview). The Dashboard
 * registers itself once its dock is ready; until then the manager works on the library only.
 */
import type { WorkspaceDoc } from '@htflow/workspace';

export interface WorkspaceHost {
  /** The current workspace with the active layout tab freshly captured. */
  snapshot(): WorkspaceDoc;
  /** Replaces the whole workspace (every layout tab) and shows its active tab. */
  load(doc: WorkspaceDoc): void;
  /** Renames the current workspace without reloading it. */
  rename(name: string): void;
  /** Activates (and reveals) a window. */
  focusWindow?(id: string): void;
  closeWindow?(id: string): void;
  isFloating?(id: string): boolean;
  /** Moves a docked window into a floating group, or a floating one back into the grid. */
  toggleFloating?(id: string): void;
  /** Detach window: OS window or floating (`auto` follows Layout settings). */
  detachWindow?(id: string, mode?: 'auto' | 'float' | 'os'): void;
}

let host: WorkspaceHost | null = null;
const waiters: ((h: WorkspaceHost) => void)[] = [];

export function setWorkspaceHost(h: WorkspaceHost | null): void {
  host = h;
  if (h) waiters.splice(0).forEach((w) => w(h));
}

export function workspaceHost(): WorkspaceHost | null {
  return host;
}

export function whenWorkspaceHost(): Promise<WorkspaceHost> {
  return host ? Promise.resolve(host) : new Promise((r) => waiters.push(r));
}
