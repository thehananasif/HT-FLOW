# Releasing HT Flow (P30)

Everything here is free: GitHub Actions, GitHub Releases, `tauri-plugin-updater` (minisign
signatures), WiX and NSIS. Code signing with a paid certificate is out of scope (see
`docs/BLOCKERS.md`).

## What a release contains

| File                                    | What it is                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTFlow-<tag>-windows-x64-setup.exe`    | NSIS installer, per-user (no admin), Start-menu and desktop shortcuts, file associations, asks whether to keep or remove user data when uninstalling |
| `HTFlow-<tag>-windows-x64.msi`          | WiX MSI of the same app (for managed deployment)                                                                                                     |
| `HTFlow-<tag>-windows-x64-portable.zip` | `HT Flow.exe` + an empty `portable` marker. Data is kept in `data\` next to the exe; no installer, no auto-update                                    |
| `*.sig`, `latest.json`                  | Only when the signing secret is set: updater signatures and the update manifest                                                                      |

File associations registered by the installers: `.htprofile`, `.htworkspace`, `.htind`,
`.httemplate`, `.htstrat`. Opening one starts HT Flow (or hands the file to the running instance); the core emits an
`htflow:open-file` event and the UI routes it to the matching importer (see "Opening files" below).

## Cut a release

1. Bump the version in `apps/desktop/src-tauri/tauri.conf.json` and the workspace `Cargo.toml`
   (`[workspace.package] version`) and `package.json`. The updater compares the version in
   `tauri.conf.json` with `latest.json`, so it must increase for every published release.
2. Write the release notes in `docs/release-notes/<tag>.md` (the workflow falls back to
   `docs/CHANGELOG.md` when the file is missing).
3. Merge to the default branch and wait for CI (it builds NSIS + MSI and runs an installer smoke test).
4. Start the **Release** workflow: either push a tag `vX.Y.Z` (`git tag vX.Y.Z && git push origin vX.Y.Z`),
   or run it from Actions -> Release -> Run workflow with the tag name (the release action creates the tag
   on that commit). Tick **draft** to review before publishing. A tag with a `-` suffix (for example
   `v0.2.0-beta.1`) is published as a pre-release.
5. Download the installer from the draft / release on a clean Windows 11 machine and run the acceptance
   check: install, create an account, open a BTCUSDT footprint with live data in under 2 minutes.
6. Publish the release. Stable updates are served from `releases/latest/download/latest.json`, which
   GitHub points at the newest published, non-pre-release release. Publishing a **pre-release** also
   refreshes the rolling `beta-channel` release that the "Beta" update channel reads.

## Release checklist

An official (non pre-release) release is cut **only** when all three are green for the exact commit
being released (details: [TESTING-WINDOWS.md](TESTING-WINDOWS.md)):

- [ ] **(a) CI green** — the `CI` workflow on that commit: typecheck, lint, format, Vitest, Rust
      fmt / clippy / tests, Playwright e2e **including the click-everything crawl** (`@clickall`,
      report `click-report`), Windows build + installer smoke test.
- [ ] **(b) `windows-app-test` green** — Actions → _Windows app test (native)_ → _Run workflow_ on
      the release branch / commit (full run, not _quick_): the real `.exe` under tauri-driver +
      WebView2, native paths and the crawl. Keep the `windows-app-test-report` artifact link in the
      release notes PR.
- [ ] **(c) Manual checklist signed off** — print [MANUAL-TEST-CHECKLIST.md](MANUAL-TEST-CHECKLIST.md)
      (regenerate first: `WRITE_CHECKLIST=1 pnpm e2e:clickall -g registry`), tick every box on a
      real Windows PC with the installed release candidate, and file / fix anything that fails.

Then follow "Cut a release" above. Pushing the `v*` tag also starts `windows-app-test` once more
against the tagged commit; do not publish the draft until that run is green.

## Auto-update setup (one time)

Updates are verified with a minisign key pair made by the free Tauri signer.

```powershell
pnpm --filter @htflow/desktop tauri signer generate -w "$HOME\.tauri\htflow.key"
```

It prints a public key and writes the private key file. Then:

1. **Private key**: add the _contents_ of `htflow.key` as the repository secret
   `TAURI_SIGNING_PRIVATE_KEY` (Settings -> Secrets and variables -> Actions). If you set a password,
   add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **Never commit the private key.** Keep an offline
   backup: if it is lost, installed copies can no longer be updated and users must reinstall.
2. **Public key**: either add it as the repository secret or variable `TAURI_UPDATER_PUBKEY` (the
   workflow injects it at build time), or paste it into `plugins.updater.pubkey` in
   `apps/desktop/src-tauri/tauri.conf.json` and commit it (it is public).
3. Run the Release workflow. With the secret present the build writes `.sig` files and the workflow
   publishes `latest.json`. **Without the secret those steps are skipped** and the release carries only
   installers; the app then shows "Updates unavailable in this build".

In the app: Command Palette -> "Check for updates" (also Settings -> About), or turn on
Settings -> About -> "Check for updates" to look at start-up (off by default; nothing is requested until
then). The channel setting (`about.updateChannel`) chooses Stable or Beta. Portable builds cannot
self-update and tell the user to download the new zip.

Updates install through the NSIS installer in passive mode and keep user data (the uninstaller
prompt is skipped for updates). An MSI install is not updated by the NSIS package; reinstall the MSI
for managed environments.

## Code signing and SmartScreen

The installers are **unsigned**. Windows Defender SmartScreen therefore shows "Windows protected your
PC - unknown publisher" the first time someone runs the setup or the portable exe. To continue:
**More info -> Run anyway**. Browsers may also warn on download ("not commonly downloaded").
SmartScreen reputation builds with downloads of a signed file; an unsigned file may keep warning.
The warning is about the missing publisher identity, not a virus verdict. Publish the SHA-256 of each
file in the release notes so users can compare (`Get-FileHash <file>`).

Free or low-cost options, none enabled here:

- **SignPath Foundation** gives free code signing to qualifying open-source projects (application and
  review required; the project must be public and MIT / OSI licensed).
- **Microsoft Trusted Signing (Azure)** is cheap but not free.
- A self-signed certificate does **not** remove the warning (users would have to trust it by hand).

The update signature above is separate from Windows code signing: it only proves an update came from
the holder of the updater key.

## Opening files (file associations)

The core (`src-tauri/src/openfile.rs`) reads the file (UTF-8, at most 32 MB) and emits
`htflow:open-file` with `{ path, name, ext, kind, text, error }`. `kind` is `profile`, `workspace`,
`indicator` or `template`. The UI (`ui/src/platform/openFile.ts`) routes by kind:

```ts
import { registerOpenFileHandler } from '../../platform/openFile';
registerOpenFileHandler(
  'indicator',
  async (file) => {
    /* parse file.text */
  },
  { needsSession: true },
);
```

Built in: `profile` (imports like the login-screen button), `template` (chart template library).
`workspace` and `indicator` have no importer yet;
opening one shows an info toast. Files that arrive before login wait until the user logs in (profiles
excepted). The same payload is dispatched as a DOM `CustomEvent('htflow:open-file')` on `window`.

## Uninstall and user data

User data lives in `%APPDATA%\HTFlow` (outside the install folder). The NSIS uninstaller asks
"Also remove your HT Flow data?" (default **No**); silent uninstalls and updates always keep it. The
MSI never touches user data. Portable data is the `data\` folder next to the exe: delete the folder to
remove everything.

## Verify without a release

- CI (`build-windows`) builds NSIS and MSI on every push and runs `scripts/release/smoke-install.ps1`:
  silent install, checks the exe / shortcuts / file associations, silent uninstall, and that user data
  survives. The smoke test is informational (it does not fail the build) until it has been seen green.
- `latest.json` generation is unit-tested (`scripts/release/latest-json.test.ts`).
- The NSIS hook (`src-tauri/windows/installer-hooks.nsh`) compiles with `makensis -WX` against a stub.

## Icon and logo sources

Owner-supplied originals live in `apps/desktop/branding/` (`app-icon.webp`, `hanan-trade-logo.webp`). Run `python3 apps/desktop/branding/generate.py` (Pillow) to rebuild `src-tauri/icons/*` (incl. `installer/*.bmp` used by the NSIS and WiX bundles), `ui/public/favicon.png` and `ui/public/brand/*`. Commit the regenerated files.
