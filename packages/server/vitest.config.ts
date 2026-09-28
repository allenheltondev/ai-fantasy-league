import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against core's TypeScript source, so no build step is needed first.
    alias: {
      '@fantasy/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@fantasy/data': fileURLToPath(new URL('../data/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/types/**'],
      // Ratchet: the achieved level. Never lower it (docs/ARCHITECTURE.md, Testing layers).
      thresholds: { lines: 99, branches: 93, functions: 98, statements: 98 }
    }
  }
});
