import { defineConfig } from 'vitest/config';

/**
 * `pnpm bench`: performance targets of the spec (P29). One file at a time in one fork so the
 * measurements do not compete for CPU; the global setup writes docs/PERFORMANCE.md at the end.
 */
export default defineConfig({
  test: {
    include: ['apps/desktop/bench/**/*.perf.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    // indicators.perf.ts collects garbage between the simulated worker and main-thread phases.
    execArgv: ['--expose-gc'],
    globalSetup: ['apps/desktop/bench/report.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
