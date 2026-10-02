import { defineConfig } from '@playwright/test';

/** Draft UI contracts use stateful API fixtures; no database or agent service is needed. */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['draft.pw.ts', 'draft-research.pw.ts', 'draft-workspace.pw.ts'],
  workers: 1,
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}
  },
  webServer: {
    command: 'npm run dev -- --port 5175 --strictPort',
    url: 'http://localhost:5175',
    reuseExistingServer: !process.env.CI
  }
});
