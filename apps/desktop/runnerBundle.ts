import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

/**
 * Builds the headless VPS runner (`ui/src/modules/strategies/vps/main.ts` + the strategy SDK,
 * the built-in strategies and the paper engine) into ONE self-contained CommonJS file for Node.js
 * 22+, using Vite's own bundler (no extra dependency). The UI imports the result as the
 * `virtual:htflow-vps-runner` string and prepends each deployment's config (`vps/bundle.ts`).
 */
export const RUNNER_ENTRY = fileURLToPath(
  new URL('./ui/src/modules/strategies/vps/main.ts', import.meta.url),
);

export async function buildRunnerCore(minify = true): Promise<string> {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      ssr: RUNNER_ENTRY,
      target: 'node22',
      minify,
      sourcemap: false,
      rollupOptions: { output: { format: 'cjs', inlineDynamicImports: true } },
    },
    ssr: { noExternal: true, target: 'node' },
  });
  const outputs = Array.isArray(out) ? out : [out];
  for (const o of outputs)
    if ('output' in o)
      for (const chunk of o.output) if (chunk.type === 'chunk' && chunk.isEntry) return chunk.code;
  throw new Error('runner bundle: no entry chunk');
}

const VIRTUAL = 'virtual:htflow-vps-runner';

export function runnerBundlePlugin(): Plugin {
  let cached: Promise<string> | null = null;
  return {
    name: 'htflow-vps-runner',
    resolveId: (id) => (id === VIRTUAL ? '\0' + VIRTUAL : undefined),
    async load(id) {
      if (id !== '\0' + VIRTUAL) return undefined;
      cached ??= buildRunnerCore();
      return `export default ${JSON.stringify(await cached)};`;
    },
    handleHotUpdate(ctx) {
      if (ctx.file.includes('/strategies/vps/') || ctx.file.includes('/packages/')) cached = null;
    },
  };
}
