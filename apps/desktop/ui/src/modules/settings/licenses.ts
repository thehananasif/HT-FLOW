/** Open-source libraries bundled in HT Flow (Settings → About). Keep in sync with package.json / Cargo.toml. */
export interface BundledLibrary {
  name: string;
  license: string;
  /** Where it is used. */
  part: 'UI' | 'Native core' | 'Fonts' | 'Tooling';
  url: string;
}

export const BUNDLED_LIBRARIES: BundledLibrary[] = [
  {
    name: 'React / React DOM',
    license: 'MIT',
    part: 'UI',
    url: 'https://github.com/facebook/react',
  },
  { name: 'Zustand', license: 'MIT', part: 'UI', url: 'https://github.com/pmndrs/zustand' },
  { name: 'Dockview', license: 'MIT', part: 'UI', url: 'https://github.com/mathuo/dockview' },
  {
    name: 'Radix UI primitives',
    license: 'MIT',
    part: 'UI',
    url: 'https://github.com/radix-ui/primitives',
  },
  {
    name: 'Lucide icons',
    license: 'ISC',
    part: 'UI',
    url: 'https://github.com/lucide-icons/lucide',
  },
  {
    name: 'Geist and Geist Mono fonts',
    license: 'SIL OFL 1.1',
    part: 'Fonts',
    url: 'https://github.com/vercel/geist-font',
  },
  {
    name: 'Tauri',
    license: 'MIT / Apache-2.0',
    part: 'Native core',
    url: 'https://github.com/tauri-apps/tauri',
  },
  { name: 'Tokio', license: 'MIT', part: 'Native core', url: 'https://github.com/tokio-rs/tokio' },
  {
    name: 'Serde',
    license: 'MIT / Apache-2.0',
    part: 'Native core',
    url: 'https://github.com/serde-rs/serde',
  },
  {
    name: 'reqwest',
    license: 'MIT / Apache-2.0',
    part: 'Native core',
    url: 'https://github.com/seanmonstar/reqwest',
  },
  {
    name: 'tracing',
    license: 'MIT',
    part: 'Native core',
    url: 'https://github.com/tokio-rs/tracing',
  },
  {
    name: 'keyring',
    license: 'MIT / Apache-2.0',
    part: 'Native core',
    url: 'https://github.com/hwchen/keyring-rs',
  },
  {
    name: 'zeroize',
    license: 'MIT / Apache-2.0',
    part: 'Native core',
    url: 'https://github.com/RustCrypto/utils',
  },
  {
    name: 'base64',
    license: 'MIT / Apache-2.0',
    part: 'Native core',
    url: 'https://github.com/marshallpierce/rust-base64',
  },
  { name: 'Vite', license: 'MIT', part: 'Tooling', url: 'https://github.com/vitejs/vite' },
  {
    name: 'Playwright',
    license: 'Apache-2.0',
    part: 'Tooling',
    url: 'https://github.com/microsoft/playwright',
  },
];

/** Project links shown on the About page. */
export const ABOUT_LINKS: { label: string; url: string }[] = [
  { label: 'Source code', url: 'https://github.com/thehananasif/HT-FLOW' },
  { label: 'Release notes', url: 'https://github.com/thehananasif/HT-FLOW/releases' },
  { label: 'Report an issue', url: 'https://github.com/thehananasif/HT-FLOW/issues' },
];
