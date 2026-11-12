# Security notes (P29)

HT Flow is local-first: no server, no account in the cloud, no telemetry. This page lists what it
protects, what it does not, and what has been checked. Report vulnerabilities through a private
GitHub security advisory on the repository, not a public issue.

## Threat model

| Asset                                                   | Where it lives                                                                                                                  | Protected against                                               | Not protected against                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Profile data (settings, workspaces, journal, templates) | `%APPDATA%\HTFlow\` (or `<exe dir>\data\` in portable mode), files sealed with XChaCha20-Poly1305 under a random data key       | Another user / a stolen disk or backup without the password     | Malware running as you while the profile is unlocked (it can read process memory) |
| Data key                                                | Wrapped by Argon2id (m=64 MB, t=3, p=1) for the password, the recovery code and the PIN; unwrapped key is `Zeroizing` in memory | Offline guessing is slow; a wrong password never decrypts       | A weak password; losing both password and recovery code (data is unrecoverable)   |
| Exchange API keys                                       | The vault (`vault_put` / `vault_get`), stored inside the encrypted profile                                                      | Disk theft; never written to logs or the crash reports          | A compromised UI process: `vault_get` returns the secret to the WebView           |
| Recorded market data (tick store)                       | the tick-store folder under the data root, plain binary files                                                                   | Corruption (CRC blocks, torn-tail repair)                       | Reading by anyone with access to your Windows account (it is public market data)  |
| Crash reports                                           | `<data>\crashes\`, plain text, redacted at write time                                                                           | Leaking user names, e-mails, `password=` values and long tokens | Anything the redaction rules do not recognise: read before you share              |

Out of scope: a compromised Windows account, keyloggers, physical access to an unlocked session,
malicious exchange servers beyond what TLS and message validation give.

### Network surface

- **Exchange connectors** talk only to the venue's public (or, later, authenticated) endpoints over
  TLS (rustls). No other host receives market or account data.
- **`net_fetch_text`** is the only generic fetch (RSS / Atom / OPML / ICS): GET only, `http` / `https`
  only, 15 s timeout, 5 MB cap checked on `Content-Length` and while streaming, at most 5 redirects, fixed
  user agent `HTFlow/0.1`, no cookies, no credentials.
- **Updater**: one GET for `latest.json` from GitHub Releases when you ask (or when
  `about.checkUpdates` is on). Installers are downloaded only after the manifest names a newer version
  and are installed only if their minisign signature verifies against the public key built into the app.
  Without a key (or in portable / web builds) the updater refuses to run.
- **Crash reporter**: writes local files only. "Report a problem" copies text to the clipboard; the
  user decides whether to paste it anywhere.
- **File associations**: opening a `.ht*` file reads it (UTF-8, 32 MB cap, fixed extension allow-list)
  and hands the text to the matching importer in the UI, which validates it. Files are never executed.
- No analytics, no ads, no remote configuration.

### WebView hardening

- CSP: `default-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`. No remote scripts, no `eval`, no `connect-src` to the internet from the WebView (all network goes through Rust commands). `'unsafe-inline'` is for styles only (charts and dockview set inline styles).
- IPC capability `default` allows the `main` window only the `core:default` set plus minimise / maximise / close / drag. Plugin commands of `tauri-plugin-updater` are registered but **not** granted to the WebView; the UI reaches updates through HT Flow's own `update_*` commands.
- Release builds hide the console window; there is no devtools shortcut in release builds.

## Verified checklist

Checked in code review and by tests as of this phase.

- [x] `net_fetch_text`: scheme allow-list, size cap, timeout, no cookies (unit tests in `net_cmds.rs`).
- [x] No password, recovery code, PIN, API key or session key reaches `tracing`, `println!` or `console.*`: every log call in `apps/desktop/src-tauri` and `crates/` was read; they log counts, paths, symbols and error strings only.
- [x] Data key and password material use `Zeroizing` (`crates/auth`).
- [x] Command errors are `{ code, message }` with fixed messages; they never echo secrets.
- [x] Crash files are redacted before they are written and again before the clipboard summary (`crash.rs` tests: user paths with spaces, e-mails, `password=` / `token:` values, 32+ character tokens).
- [x] Crash writer cannot overwrite arbitrary files: the file name is generated (`crash-<unix>-<kind>.txt`, kind restricted to `[a-z0-9-]`), the report is capped at 64 KB, at most 20 files are kept.
- [x] Open-file routing only accepts the five known extensions, regular files, UTF-8, at most 32 MB.
- [x] Updater refuses to run without a public key, and in portable builds; unsigned artifacts are rejected by the plugin.
- [x] Unsigned installer behaviour and SmartScreen are documented in `docs/RELEASE.md`.
- [x] No `dangerouslySetInnerHTML`, `eval` or `new Function` in the UI.
- [x] Ribbon and title-bar buttons have accessible names (Playwright check in `e2e/platform.spec.ts`).

## Open items

- [ ] Code signing of the installer (paid certificate; see `docs/BLOCKERS.md` and `docs/RELEASE.md` for free options).
- [ ] Run `cargo audit` and `pnpm audit` in CI and triage the output.
- [ ] Full axe-core accessibility run (`@axe-core/playwright` is not installed; adding a dev dependency was avoided).
- [ ] 8-hour soak test on live streams and the Windows install-to-footprint timing check from the P30 acceptance list: both need a real Windows machine with network access.
- [ ] Authenticated exchange trading is not built; when it is, add per-venue key permission guidance (trade only, no withdrawal) and re-run this review.
