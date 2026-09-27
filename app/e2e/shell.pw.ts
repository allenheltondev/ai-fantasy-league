import { expect, test } from '@playwright/test';

// The runtime config a deployed bucket serves (written by `make
// deploy-frontend`). Rendering the sign-in form makes no Cognito call, so a
// placeholder client id is enough here.
const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };

test.beforeEach(async ({ page }) => {
  await page.route('**/auth-config.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_CONFIG) })
  );
});

test('a signed-out visitor to a deep link lands on the sign-in page', async ({ page }) => {
  await page.goto('/leagues/L1/draft');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page).toHaveTitle('Fantasy');
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByTestId('auth-not-configured')).toHaveCount(0);
});

test('the sign-up and forgot-password flows are reachable from sign-in', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: /create an account/i }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByLabel(/first name/i)).toBeVisible();
  await page.getByRole('link', { name: /^sign in$/i }).click();
  await page.getByRole('link', { name: /forgot password/i }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
});
