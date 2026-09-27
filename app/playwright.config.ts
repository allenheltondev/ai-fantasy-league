import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Sandbox environments preinstall Chromium at a revision @playwright/test may
// not auto-discover; pin it there when present. Elsewhere (CI, dev machines)
// fall back to Playwright's own resolution (`npx playwright install chromium`).
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const PORT = 5173;

/**
 * E2E for the SPA shell. Specs are `*.pw.ts` so vitest's default glob never
 * picks them up. The Vite dev server is booted as a `webServer`; once the local
 * API server exists (packages/server/src/local.ts) it joins this list so the
 * specs can drive real flows against dynalite and the fake model.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}
      }
    }
  ],
  webServer: [
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000
    }
  ]
});
