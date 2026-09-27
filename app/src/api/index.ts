import { getFreshIdToken, signOut } from '@readysetcloud/ui/auth';
import { createApiClient } from './client';

export * from './client';

/**
 * The app's API client: the signed-in user's ID token (refreshed by the auth
 * package when near expiry) on every call, and a 401 drops the local session
 * so the router sends the user back to sign-in.
 */
export const apiFetch = createApiClient({
  getToken: getFreshIdToken,
  onUnauthorized: () => {
    void signOut();
  }
});
