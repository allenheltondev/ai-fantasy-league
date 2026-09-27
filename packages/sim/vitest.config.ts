import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against core's and data's TypeScript source, so no build step is needed first.
    alias: {
      '@fantasy/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@fantasy/data': fileURLToPath(new URL('../data/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLIs are thin argument parsers over tested functions; `src/cli/args.ts` is tested.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/cli/archive.ts', 'src/cli/run.ts'],
      // Ratchet: set at the achieved level; never lower (docs/ARCHITECTURE.md).
      thresholds: { lines: 99, branches: 90, functions: 97, statements: 98 }
    }
  }
});
