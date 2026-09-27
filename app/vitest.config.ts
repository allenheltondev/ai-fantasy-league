import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Playwright owns e2e/; keep vitest out of it.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/test/**',
        // Bootstrap only: mounts React, no branching logic of its own to cover.
        'src/main.tsx'
      ],
      // Ratchet, not aspiration: pinned at the achieved numbers, rounded down.
      // Raise them when coverage improves; never lower them.
      thresholds: {
        statements: 98,
        branches: 98,
        functions: 95,
        lines: 98
      }
    }
  }
});
