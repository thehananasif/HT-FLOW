/**
 * What the click-everything crawlers may click, and which console messages are known benign.
 * Shared by the Playwright spec (web build) and the WebdriverIO native smoke test (real Tauri).
 * Keep this list short and explained: a new entry must name why the message / control is safe to
 * skip. Real app bugs get fixed, not allow-listed.
 */

/**
 * Controls never clicked inside a surface: they destroy data, end the session, close the window
 * under test or leave the app. Matched against the control's label and data-testid.
 */
export const DESTRUCTIVE: RegExp[] = [
  /\b(delete|remove|reset|clear|wipe|erase|purge|forget|revoke|uninstall|discard)\b/i,
  /\b(log ?out|sign ?out|quit|exit|lock)\b/i,
  /\b(kill|panic|flatten|liquidate)\b/i,
  /\b(close|cancel) all\b/i,
  /\brestore defaults?\b/i,
  // Window chrome: closing / minimising the window under test ends the crawl of that surface.
  /^(close|close window|minimi[sz]e|maximi[sz]e|×|✕|x)$/i,
  /\bwin-close\b/i,
];

/** Command Palette commands run last in their own fresh context (or not at all). */
export const DESTRUCTIVE_COMMANDS: RegExp[] = [
  /reset/i,
  /delete/i,
  /log ?out|sign ?out|lock/i,
  /quit|exit/i,
  /kill/i,
  /flatten|close all|cancel all/i,
  /clear/i,
  /remove/i,
];

/** Ids of commands that are safe but change the whole UI (language, theme) — run, then undo. */
export const UNDO_AFTER: Record<string, string> = {
  'lang.ur': 'lang.en',
};

/**
 * Console messages that are not app errors. Each entry: pattern and the reason.
 * The web build has no native core, so "not available in the browser" style messages are expected.
 */
export const BENIGN_CONSOLE: { re: RegExp; why: string }[] = [
  { re: /Download the React DevTools/i, why: 'React dev-mode banner' },
  {
    re: /Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_REFUSED|PROXY|TUNNEL|CERT)/i,
    why: 'CI runners have restricted network; live exchange / news fetches fail by design',
  },
  {
    re: /WebSocket connection to 'wss?:\/\/.*' failed/i,
    why: 'live exchange sockets are not reachable from CI; the feed shows its error state',
  },
  {
    re: /\[vite\] (connecting|connected|server connection lost)/i,
    why: 'Vite dev-server HMR chatter',
  },
];

export function isDestructive(label: string, testid?: string): boolean {
  const s = `${label} ${testid ?? ''}`.trim();
  return DESTRUCTIVE.some(
    (re) => re.test(label) || (testid ? re.test(testid) : false) || re.test(s),
  );
}

export function isDestructiveCommand(id: string, label: string): boolean {
  return DESTRUCTIVE_COMMANDS.some((re) => re.test(id) || re.test(label));
}

export function isBenign(message: string): boolean {
  return BENIGN_CONSOLE.some((b) => b.re.test(message));
}
