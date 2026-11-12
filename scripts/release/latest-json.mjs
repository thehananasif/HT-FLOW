/* global process, console */
/**
 * Builds the updater manifest `latest.json` for tauri-plugin-updater from a signed NSIS installer.
 *
 *   node scripts/release/latest-json.mjs --tag v0.2.0 --repo owner/name \
 *     --installer dist/HTFlow-v0.2.0-windows-x64-setup.exe --notes docs/release-notes/v0.2.0.md \
 *     --out dist/latest.json
 *
 * The installer must have a sibling `<installer>.sig` (written by `tauri build` when
 * TAURI_SIGNING_PRIVATE_KEY is set). The manifest `version` is the app version from
 * tauri.conf.json (what the running app compares against), not the tag.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure builder, exported for tests. */
export function buildLatestJson({ version, notes, pubDate, repo, tag, installerName, signature }) {
  if (!version || !signature) throw new Error('version and signature are required');
  const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installerName)}`;
  const entry = { signature: signature.trim(), url };
  return {
    version,
    notes: (notes ?? '').slice(0, 4000),
    pub_date: pubDate,
    platforms: { 'windows-x86_64': entry, 'windows-x86_64-nsis': entry },
  };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function main() {
  const a = args(process.argv.slice(2));
  for (const k of ['tag', 'repo', 'installer', 'out']) if (!a[k]) throw new Error(`--${k} missing`);
  if (!/^v[0-9A-Za-z.-]+$/.test(a.tag)) throw new Error(`Unexpected tag: ${a.tag}`);
  const conf = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
  const json = buildLatestJson({
    version: conf.version,
    notes: a.notes ? readFileSync(a.notes, 'utf8') : '',
    pubDate: new Date().toISOString(),
    repo: a.repo,
    tag: a.tag,
    installerName: basename(a.installer),
    signature: readFileSync(`${a.installer}.sig`, 'utf8'),
  });
  writeFileSync(a.out, JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote ${a.out} (version ${json.version})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
