import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/desktop/ui/**/*.test.{ts,tsx}'],
    environment: 'node',
    pool: 'threads',
  },
});
