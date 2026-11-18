# Security audit — round 6

Scope: the whole repository at `724e096` (Tauri 2 core in `apps/desktop/src-tauri` and `crates/*`,
React UI in `apps/desktop/ui`, `packages/*`, GitHub Actions). Threat model: a local desktop app
that talks to public exchange APIs, stores encrypted profiles and secrets, opens files the user
double-clicks, runs user indicator scripts, fetches RSS / news URLs and opens WebSockets to
user-provided hosts. A compromised Windows account or malware running as the user is out of
scope (see [SECURITY.md](SECURITY.md)).

Method: every `#[tauri::command]` was read with its inputs traced to file paths, URLs and
allocations; the auth / vault crates were reviewed for crypto parameters, key handling and
untrusted-file parsing; the tick-store binary format was fuzzed with corrupted files; the UI was
searched for HTML / script sinks, link handling, CSV / XLSX writers and the HT Script interpreter;
workflows were read for token permissions, secret exposure and expression injection; `Cargo.lock`
was checked by hand against known RustSec advisories (`cargo audit` is not installed here).

## Findings

| #   | Severity | Area                                    | Location                                                    | Status |
| --- | -------- | --------------------------------------- | ----------------------------------------------------------- | ------ |
| 1   | High     | Profile import path traversal           | `crates/auth/src/lib.rs` `ProfileStore::import`             | Fixed  |
| 2   | Medium   | 6-digit PIN brute-forceable offline     | `crates/auth/src/lib.rs` (PIN wrap), `export`               | Fixed  |
| 3   | Medium   | Untrusted Argon2 parameters (DoS/panic) | `crates/auth/src/lib.rs` `derive` / `unwrap`                | Fixed  |
| 4   | Medium   | Updater signing key exposed to installs | `.github/workflows/release.yml` (workflow-level `env`)      | Fixed  |
| 5   | Medium   | Tokens in URLs survive crash redaction  | `apps/desktop/src-tauri/src/crash.rs` `redact_line`         | Fixed  |
| 6   | Low      | Feed redirect to local network (SSRF)   | `apps/desktop/src-tauri/src/net_cmds.rs` redirect policy    | Fixed  |
| 7   | Low      | Unbounded allocation from block count   | `crates/tick-store/src/file.rs` `check_block`, `read_range` | Fixed  |
| 8   | Low      | `rescale_px` i128 overflow              | `crates/tick-store/src/file.rs`                             | Fixed  |
| 9   | Low      | `javascript:` links from feeds          | `packages/info/src/feed.ts` `resolve`, `reader.ts`          | Fixed  |
| 10  | Low      | CSV formula injection                   | `apps/desktop/ui/src/components/DataTable.utils.ts`         | Fixed  |
| 11  | Low      | HT Script built-in lookup via prototype | `packages/indicator-sdk/src/script/compile.ts`              | Fixed  |
| 12  | Low      | Secrets left in freed memory            | `crates/vault` `SealedMap`, `auth_cmds.rs` IPC strings      | Fixed  |
| 13  | Low      | Counter overflow on tampered profile    | `crates/auth/src/lib.rs` `failed_attempts += 1`             | Fixed  |
| 14  | Low      | Custom WS batch could buffer ~512 MB    | `apps/desktop/src-tauri/src/custom_ws.rs`                   | Fixed  |
| 15  | Low      | Open-file size TOCTOU                   | `apps/desktop/src-tauri/src/openfile.rs` `load`             | Fixed  |
| 16  | Low      | CI token permissions not restricted     | `.github/workflows/ci.yml`                                  | Fixed  |
| 17  | Low      | `vault_put` without size limits         | `apps/desktop/src-tauri/src/auth_cmds.rs`                   | Fixed  |
| 18  | Info     | Items reviewed and left as they are     | see "Remaining"                                             | Open   |

### 1. High — `.htprofile` import writes outside the profiles folder

`import` used `meta.id` from the bundle as a directory name (`profiles_dir().join(&meta.id)`)
after checking only that no profile already had that exact id. The UI imports a double-clicked
`.htprofile` immediately, without a session or a confirmation (`platform/openFile.ts`).

Exploit: send a user `report.htprofile` with `"id": "../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"`
(or an absolute path, which `Path::join` takes as is, or `"x/../<victim profile id>"`). Opening
it writes `profile.json`, `settings.bin` and `vault.bin` with attacker-chosen bytes into that
folder, overwriting files of those names, including another local profile's encrypted vault
(data loss). The username and display name were not validated either.

Fix: the id is used only if it is a canonical hyphenated UUID, otherwise a fresh one is
generated; username must pass the same rule as sign-up; display name is trimmed, capped at 64
chars and stripped of control and bidi-override characters; wrapped keys must have sane KDF
parameters, salt and blob sizes. Test: `import_rejects_path_traversal_and_bad_fields`.

### 2. Medium — the PIN made a copied profile brute-forceable

The data key was wrapped under `Argon2id(PIN)`. A PIN has 10^6 values, so anyone with a copy of
`profile.json` (stolen disk, backup, or an exported `.htprofile` on a USB stick or cloud folder)
could try every PIN offline (about 10^6 × 64 MB Argon2: hours on a multi-core machine) and
recover the data key, the encrypted settings and the exchange / Telegram / Discord secrets,
defeating the "stolen disk without the password" protection whenever a PIN was set. The
5-attempt lockout only applies inside the app.

Fix: the PIN wrap now also mixes in a random 32-byte per-profile pepper stored in the Windows
Credential Manager (`KeyringPepper`, DPAPI-protected for the signed-in user; same store as
"Remember me"). Without the pepper the PIN cannot be tested. If the credential store is not
available a PIN is refused (`auth.pin_unavailable`) instead of silently falling back to a weak
wrap. Existing PINs are re-wrapped with the pepper on the next successful PIN unlock. Exports
never contain the PIN wrap, imports drop one (set the PIN again after moving a profile). Tests:
`pin_is_peppered_and_never_exported`, `legacy_pin_is_upgraded_to_peppered`.

### 3. Medium — Argon2 parameters read from files were trusted

`derive` built `Params` from `profile.json` / an imported bundle and called `expect`. A crafted
bundle with `m_kib = 4294967295` made every login allocate 4 TB (abort), `m_kib = 0` or a
4-byte salt panicked. Fix: `KdfParams::is_sane` (m 8 KiB–1 GiB, t 1–16, p 1–8), salt 8–64
bytes, and derivation failures return "wrong password" instead of panicking. Imports reject
insane parameters. Test: `tampered_kdf_on_disk_fails_closed_without_panicking`.

### 4. Medium — updater signing key visible to every release step

`TAURI_SIGNING_PRIVATE_KEY` and its password were in the workflow-level `env`, so every step
saw them, including `pnpm install --frozen-lockfile`, which runs third-party install scripts. A
compromised dev dependency could read and exfiltrate the key, then sign malicious updates that
installed copies of HT Flow would accept. Fix: only `HAS_SIGNING_KEY` (true/false) is global;
the key and password are passed to the "Tauri build" step alone; the signing config path is
passed through `env` instead of being spliced into the PowerShell script. CI also declares
`permissions: contents: read` (finding 16).

### 5. Medium — tokens inside URLs were written to crash reports

Redaction worked per whitespace-separated word; a Discord webhook URL
(`https://discord.com/api/webhooks/<id>/<token>`) or a Telegram API URL with
`bot<id>:<token>` contains `:` / `/` / `.` and so matched neither the `key=value` nor the
32-char-token rule. An error message or stack carrying such a URL would end up in a crash file
and in the "Report a problem" clipboard text the user is invited to paste publicly. Fix:
`redact_embedded` checks each piece between `/ : ? & = # ; ,` and hides query values. Test:
`redacts_tokens_inside_urls`.

### 6. Low — RSS fetch could be redirected to local addresses

`net_fetch_text` followed up to 5 redirects anywhere. A feed on the internet could bounce the app
to `http://192.168.1.1/...`, `http://127.0.0.1:<port>/...` or `169.254.169.254` (blind GET from
the user's machine, CSRF-style requests to routers / local dev servers). Fix: a custom redirect
policy refuses a redirect from a public host to loopback, private, link-local, CGNAT,
unspecified or IPv6 ULA / link-local addresses and `localhost`. Feeds the user deliberately
points at a local host still work. DNS names that resolve to private addresses are not covered
(no resolver hook in reqwest; low value for a GET-only, no-cookie client). Test:
`redirects_cannot_reach_local_addresses`.

### 7–8. Low — tick-store parsing of corrupted files

The block record count is not covered by the payload CRC and sized the zstd output buffer
(`count × 39` bytes): one flipped bit (disk corruption) or a crafted file could request ~160 GB
and abort the app. The index file's count was trusted the same way. Fix: counts above
`MAX_BLOCK_RECORDS` (the codec's existing bound) or `min_ts > max_ts` end the valid prefix, and
`read_range` skips a block whose header count differs from the index. `rescale_px` now uses
checked arithmetic and saturates (absurd tick sizes from a corrupted header overflowed i128 in
debug builds). Tests: `huge_record_count_is_rejected_not_allocated` and
`corrupted_files_never_panic` (300 rounds of random byte corruption and truncation of data and
index, exercising `load_index`, `read_range` with and without rescaling, and `DayWriter::open`).

### 9. Low — non-http links from feeds

Feed `<link>` / Atom `href` values were kept as-is, and the News window renders them in
`<a href>`. A `javascript:` link would run on a middle-click in the browser build; in the desktop
app the CSP blocks inline script, so impact is low. Fix: `safeLink` keeps only absolute http(s)
links without control characters, also for cached items loaded from settings. Test:
`packages/info/src/security.test.ts`.

### 10. Low — CSV export formula injection

`toCsv` (journal, every DataTable export) wrote text cells verbatim; a cell such as
`=HYPERLINK(...)` or `+cmd|' /C calc'!A0` (journal notes, exchange-provided names) is executed
by Excel / LibreOffice when the CSV is opened. Fix: text starting with `= + - @`, tab or CR gets
a leading `'` unless it is a plain number. XLSX export already writes `inlineStr` cells, which
are never evaluated. Test in `DataTable.test.ts`.

### 11. Low — HT Script built-in tables were looked up with `in` / `[]`

`name in FUNCS`, `FUNCS[name]`, `NAMED_OK` and `PLOT_KINDS` also matched `constructor`,
`toString`, `valueOf`, `__proto__` from `Object.prototype`. This did **not** give code
execution (evaluation dispatches through a `switch` and never calls the looked-up value), but
`valueOf(1)` compiled as a declaration and `constructor(close)` passed the argument check. Fix:
own-property lookups. Verified sandbox properties: no `eval` / `new Function`, no member access,
loops or recursion, unknown names are compile errors, source ≤ 20,000 chars and ≤ 4,000 AST
nodes, look-backs clamped to 5,000 bars, at most 32 inputs / plots, and scripts run in a Web
Worker so a slow script cannot freeze the UI. Test: "HT Script sandbox" in `script.test.ts`.

### 12–17. Low — hardening

- Vault values are zeroized when replaced, removed and when the map is dropped (lock / log out);
  PIN, old / new password and recovery words received over IPC are wrapped in `Zeroizing`.
- `failed_attempts` / `pin_failures` use saturating adds (a tampered `u32::MAX` panicked in debug).
- Custom WebSocket batches are also flushed at 4 MB, not only at 512 frames.
- Opened `.ht*` files are read through `take(32 MB + 1)`, so a file that grows after the size
  check is still refused.
- `vault_put` caps keys at 256 bytes and values at 64 KB.

## Web Pages native window (round 7)

The desktop Web Pages panel shows remote sites in its own `webpage-<id>` Tauri window
(`src-tauri/src/webpage_cmds.rs`). Remote content is the threat; the design keeps it away from
every Tauri command.

- **No IPC.** `capabilities/default.json` is scoped to `windows: ["main"]` with no `remote`
  entry, so `webpage-*` windows hold no permissions. On top of that Tauri 2.12 rejects custom
  commands from non-local origins unless a `remote` capability allows them, and none does. A
  vitest guard (`policy.test.ts`) fails if the capability ever lists another window or a remote
  context. The `unstable` multi-webview feature stays off.
- **Scheme and host policy in Rust**, not only in the UI: `validate_url` / `url_permitted` accept
  only `http` / `https` with a host and no `user:pass@` (phishing and credential-leak vector).
  `on_navigation` cancels everything else (`file:`, `javascript:`, `data:`, `blob:`, `tauri:`,
  `ipc:`, `about:`, custom protocols), redirects included, because it runs for every top-level
  navigation. The same check guards `webpage_open`, `webpage_navigate` and
  `webpage_open_external`.
- **Allow-list** per panel (empty = any site). Matching is on label boundaries
  (`evilexample.com` and `example.com.evil.io` do not match `example.com`), case-insensitive,
  trailing dots stripped. It is applied to redirects and link clicks, and updated live.
- **New windows.** `window.open` / `target=_blank` are always denied as windows; an allowed URL
  loads in the same window or opens in the system browser (`explorer` / `open` / `xdg-open`
  with the URL as one argument, never through a shell; http(s) only).
- **Hardening of inputs.** Panel ids are restricted to `[A-Za-z0-9_-]{1,64}` before they become a
  label; bounds are clamped; the window dies with the main window.
- **Residual risks.** The page window shares the default WebView2 profile, so cookies and logins
  persist between panels and sessions (intended for logging in to sites, but a malicious page
  can see cookies it set earlier). It runs at the OS user's privilege like any browser tab, so a
  WebView2 engine exploit is out of scope; keep Windows / WebView2 updated. Sub-frames and
  sub-resources are not filtered by the allow-list. Not exercised on Windows WebView2 in CI.

## Remaining (not changed, with rationale)

- **`vault_get` returns secrets to the WebView.** By design (alert delivery runs in the UI). An
  XSS in the WebView could read them; mitigated by the strict CSP (no remote scripts, no inline
  script, no `connect-src` to the internet) and the absence of HTML sinks. Moving Telegram /
  Discord sending into Rust (secret never leaves the core) is the next step.
- **Exchange WebSockets use tungstenite defaults** (64 MB message, 16 MB frame). Hosts are fixed
  exchange endpoints over TLS; tightening belongs with the connector work in progress.
- **Symbols are interpolated into REST paths / queries unencoded** in connectors. Hosts are fixed
  and the endpoints are public and unauthenticated, so this is parameter confusion, not SSRF.
  Encode when authenticated trading is added.
- **CSP keeps `style-src 'unsafe-inline'`**: charts and dockview set inline styles; style
  injection needs an HTML sink, and there is none.
- **Actions are pinned by tag** (`actions/checkout@v4`, `softprops/action-gh-release@v2`, …), not
  by commit SHA. Pinning needs verified SHAs and a bump process (Dependabot); recommended.
- **Rust advisories (manual check of `Cargo.lock`)**: no known-vulnerable versions of rustls,
  rustls-webpki, ring, tungstenite, hyper, h2, reqwest, tokio, idna, url, crossbeam-channel,
  slab, tar, time, quinn-proto or tracing-subscriber. `glib 0.18` (RUSTSEC-2024-0429) and the
  unmaintained gtk-rs 0.18 crates come from Tauri's Linux backend and are not in Windows builds;
  `proc-macro-error` (unmaintained) is build-time only. Add `cargo audit` to CI.
- **npm advisories**: only dev tools (vitest / tinypool / minimatch), handled separately.
- **Web dev backend** (`ui/src/backend/web.ts`, PBKDF2 + localStorage) is for `pnpm dev:web` and
  Playwright only and is not shipped in the desktop build.
- **Updater** is disabled until a public key is configured (`plugins.updater.pubkey` is empty);
  when enabled, signatures are verified by `tauri-plugin-updater`.
- **Pre-existing formatting**: 8 connector JSON fixtures from the klines commit fail
  `pnpm format:check`; left for the connector work to avoid conflicts.

## Verified as sound

Argon2id m=64 MiB t=3 p=1 with 16-byte random salts; XChaCha20-Poly1305 with random 192-bit
nonces and purpose-bound AAD; 24-word recovery codes from a 256-word list (192 bits, unbiased);
login back-off; fixed-message command errors; crash-file names generated, kind filtered,
reports capped and pruned; open-file extension allow-list; `net_post_json` restricted to https
Discord hosts; `net_fetch_text` http(s)-only with 5 MB / 15 s caps and no cookies; custom WS
frame caps; data export file names built from validated dates and sanitized instruments; tick-store
instrument directories sanitized; no `unsafe` in the workspace; no TLS verification disabled;
no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in the UI; external links
open only for http(s); release workflow validates the tag before using it in shell commands and
passes event data through `env`.

## Test results (this round)

- `cargo test -p htflow-auth -p htflow-vault -p htflow-tick-store -p htflow-desktop`: all pass
  (auth 10, vault 2, tick-store 10 + 7, desktop 26).
- `cargo +stable clippy -p htflow-auth -p htflow-vault -p htflow-tick-store -p htflow-desktop --all-targets -- -D warnings`: clean.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (115 files, 1,361 tests): pass.
