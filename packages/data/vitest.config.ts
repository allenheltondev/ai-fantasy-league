import { defineConfig } from 'vitest/config';

export default defineConfig({
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
