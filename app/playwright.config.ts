import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Sandbox environments preinstall Chromium at a revision @playwright/test may
// not auto-discover; pin it there when present. Elsewhere (CI, dev machines)
// fall back to Playwright's own resolution (`npx playwright install chromium`).
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
// Overridable so two checkouts can run their e2e suites side by side.
const PORT = Number(process.env.E2E_PORT ?? 5173);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8787);

/**
 * E2E for the SPA against the local API server (packages/server/src/local.ts):
 * dynalite, fixture players, the fake model, and dev sign-in (`Bearer dev:<handle>`).
 * The clock is pinned early in the 2026 season so a new league always has
 * weeks left to play. Specs are `*.pw.ts` so vitest's default glob never picks
 * them up.
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
      command: 'npm run dev --workspace=@fantasy/server',
      cwd: '..',
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      env: {
        PORT: String(API_PORT),
        FANTASY_LOCAL_AUTH: '1',
        FANTASY_FAKE_MODEL: '1',
        FANTASY_LOCAL_NOW: '2026-09-10T12:00:00Z',
        // An in-season league for dev user local-season-e2e (e2e/lineup.pw.ts).
        FANTASY_LOCAL_SEASON_DEMO: 'season-e2e'
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000
    },
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      env: { FANTASY_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000
    }
  ]
});
