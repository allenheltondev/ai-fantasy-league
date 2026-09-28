import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '@readysetcloud/ui';
import { AUTH_KEY, configureAuth } from '@readysetcloud/ui/auth';
import { App } from '../App';
import type { LeagueApi } from '../api/league';
import { toAuthConfig } from '../auth/authConfig';
import { ConfigContext } from '../config/ConfigContext';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { fakeApi } from './fakeApi';

export const TEST_CONFIG: RuntimeConfig = {
  region: 'us-east-1',
  userPoolId: 'us-east-1_test',
  clientId: 'test-client'
};

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An unsigned JWT; the auth package only decodes claims client-side. */
export function fakeIdToken(claims: Record<string, unknown>): string {
  return [base64url(JSON.stringify({ alg: 'none' })), base64url(JSON.stringify(claims)), 'sig'].join('.');
}

/** Store an `rsc:auth` session the way the auth package does after sign-in. */
export function signInAs(claims: Record<string, unknown>) {
  localStorage.setItem(
    AUTH_KEY,
    JSON.stringify({
      idToken: fakeIdToken(claims),
      refreshToken: 'refresh',
      expiresAt: 4_102_444_800_000
    })
  );
}

export function renderApp(
  path: string,
  config: RuntimeConfig | null = TEST_CONFIG,
  api: LeagueApi = fakeApi()
) {
  configureAuth(config ? toAuthConfig(config) : null);
  return render(
    <ToastProvider>
      <ConfigContext.Provider value={{ auth: config }}>
        <MemoryRouter initialEntries={[path]}>
          <App api={api} />
        </MemoryRouter>
      </ConfigContext.Provider>
    </ToastProvider>
  );
}
