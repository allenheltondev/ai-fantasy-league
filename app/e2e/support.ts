import type { BrowserContext, Page } from '@playwright/test';

// The runtime config a deployed bucket serves (written by `make
// deploy-frontend`). Rendering the sign-in form makes no Cognito call, so a
// placeholder client id is enough here.
export const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };

// A 1x1 transparent PNG: player headshots and team logos come from Sleeper's CDN (#222), which
// tests never reach. Serving a real image keeps the loaded path honest; the fallback path is
// covered by component tests.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

export async function stubSleeperCdn(target: Page | BrowserContext): Promise<void> {
  await target.route('**/sleepercdn.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
  );
}

export async function serveAuthConfig(target: Page | BrowserContext): Promise<void> {
  await stubSleeperCdn(target);
  await target.route('**/auth-config.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_CONFIG) })
  );
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** A unique dev handle per run, so reruns against a reused API server start clean. */
export function handle(name: string): string {
  return `${name}-${Date.now().toString(36)}`;
}

/**
 * Signs a browser context in as a local dev user. The auth package reads an unsigned ID token's
 * claims from localStorage; the local API only accepts `Bearer dev:<handle>`, so API calls are
 * rewritten to carry that instead (the same user: `local-<handle>`).
 */
export async function signInAs(context: BrowserContext, who: string): Promise<void> {
  await serveAuthConfig(context);
  const claims = { sub: `local-${who}`, email: `${who}@localhost`, given_name: who };
  const idToken = [base64url('{"alg":"none"}'), base64url(JSON.stringify(claims)), 'sig'].join('.');
  const session = JSON.stringify({ idToken, refreshToken: 'refresh', expiresAt: 4_102_444_800 });
  await context.addInitScript((value) => localStorage.setItem('rsc:auth', value), session);
  await context.route('**/api/v1/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer dev:${who}` } })
  );
}
