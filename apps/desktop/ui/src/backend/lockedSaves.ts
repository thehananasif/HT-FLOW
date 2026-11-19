/**
 * Settings saved while HT Flow is locked. The Rust side drops the decrypted session on lock, so
 * `settings_set` answers `auth.locked`; stores that save on a timer (alerts, activity log, AI,
 * journal …) would otherwise lose that write and leave an unhandled rejection. The last value per
 * key is kept in memory and written once the same profile is unlocked again. Logging out, or
 * signing in as another profile, drops them.
 */
export class LockedSaves {
  private pending = new Map<string, string>();
  private owner: string | null = null;

  /** A session started (login, PIN unlock, auto login, new account). */
  started(profileId: string): Map<string, string> {
    const same = this.owner === profileId;
    const out = same ? this.pending : new Map<string, string>();
    this.pending = new Map();
    this.owner = profileId;
    return out;
  }

  /** A save was refused because the app is locked. */
  hold(key: string, json: string): void {
    if (this.owner !== null) this.pending.set(key, json);
  }

  /** Logged out: nothing pending belongs to anyone any more. */
  clear(): void {
    this.pending.clear();
    this.owner = null;
  }

  get size(): number {
    return this.pending.size;
  }
}
