import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against core's TypeScript source, so no build step is needed first.
    alias: { '@fantasy/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) }
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Ratchet: set at the achieved level; never lower (docs/ARCHITECTURE.md).
      thresholds: { lines: 99, branches: 95, functions: 98, statements: 99 }
    }
  }
});
