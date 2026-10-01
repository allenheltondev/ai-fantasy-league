/**
 * The sign-in flows against a stubbed Cognito endpoint: the auth package
 * talks to cognito-idp with plain fetch, so stubbing fetch exercises the real
 * package end to end without any network.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../api';
import { fakeIdToken, renderApp, signInAs } from '../test/render';
import { RETURN_KEY } from './AuthScreens';

function cognito(handler: (target: string, body: Record<string, unknown>) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('cognito-idp')) return new Response('{}', { status: 404 });
    const headers = new Headers(init?.headers);
    const target = (headers.get('x-amz-target') ?? '').split('.').pop() ?? '';
    return handler(target, JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
  });
}

function cognitoError(type: string, message = type) {
  return new Response(JSON.stringify({ __type: type, message }), {
    status: 400,
    headers: { 'content-type': 'application/x-amz-json-1.1' }
  });
}

async function submitLogin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/email/i), 'alice@example.com');
  await user.type(screen.getByLabelText(/password/i, { selector: 'input' }), 'Password123');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sign-in flows', () => {
  it('signs in and returns to the page that asked for it', async () => {
    cognito((target) => {
      if (target === 'InitiateAuth') {
        return new Response(
          JSON.stringify({
            AuthenticationResult: {
              IdToken: fakeIdToken({ sub: 'u1', email: 'alice@example.com', exp: 4_102_444_800 }),
              RefreshToken: 'refresh',
              ExpiresIn: 3600
            }
          }),
          { status: 200 }
        );
      }
      return cognitoError('UnexpectedTarget');
    });
    const user = userEvent.setup();
    renderApp('/leagues/new');
    await submitLogin(user);
    expect(await screen.findByRole('heading', { name: 'Create League' })).toBeInTheDocument();
  });

  it('still signs in when session storage is unavailable', async () => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error('blocked');
      });
    }
    renderApp('/login');
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    vi.restoreAllMocks();
    cognito((target) =>
      target === 'InitiateAuth'
        ? new Response(
            JSON.stringify({
              AuthenticationResult: {
                IdToken: fakeIdToken({ sub: 'u1', email: 'alice@example.com', exp: 4_102_444_800 }),
                RefreshToken: 'refresh',
                ExpiresIn: 3600
              }
            }),
            { status: 200 }
          )
        : cognitoError('UnexpectedTarget')
    );
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    sessionStorage.setItem(RETURN_KEY, '/leagues/new');
    await submitLogin(userEvent.setup());
    expect(await screen.findByRole('heading', { name: 'Create League' })).toBeInTheDocument();
  });

  it('routes an unconfirmed account to the confirm step', async () => {
    cognito(() => cognitoError('UserNotConfirmedException', 'User is not confirmed.'));
    const user = userEvent.setup();
    renderApp('/login');
    await submitLogin(user);
    expect(await screen.findByLabelText(/code/i)).toBeInTheDocument();
  });

  it('routes a required password reset to the reset step', async () => {
    cognito(() => cognitoError('PasswordResetRequiredException', 'Password reset required.'));
    const user = userEvent.setup();
    renderApp('/login');
    await submitLogin(user);
    expect(await screen.findByLabelText(/new password/i)).toBeInTheDocument();
  });
});

describe('signed-in shell', () => {
  it('signs out from the AppNav profile menu', async () => {
    cognito(() => new Response('{}', { status: 200 }));
    signInAs({ sub: 'u1', email: 'alice@example.com' });
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'My Leagues' });
    // The last league (#212) is this person's: whoever signs in next starts at My Leagues.
    localStorage.setItem('aff:lastLeagueId', 'L1');
    const signOutControl = await openSignOut(user);
    await user.click(signOutControl);
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(localStorage.getItem('aff:lastLeagueId')).toBeNull();
  });

  it('the default API client drops the session on a 401', async () => {
    signInAs({ sub: 'u1', email: 'alice@example.com', exp: 4_102_444_800 });
    renderApp('/');
    await screen.findByRole('heading', { name: 'My Leagues' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sign in again.' } }), {
        status: 401
      })
    );
    await expect(apiFetch('/leagues')).rejects.toMatchObject({ status: 401 });
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('rsc:auth')).toBeNull());
  });
});

/** AppNav tucks sign-out behind the profile menu; open it if needed. */
async function openSignOut(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const direct = screen.queryAllByRole('button', { name: /sign out/i });
  if (direct[0]) return direct[0];
  // Exactly AppNav's profile button: the rail has other "menu" buttons (focus mode's Hide menu).
  await user.click(screen.getByRole('button', { name: 'Open profile menu' }));
  const found = screen.queryAllByRole('button', { name: /sign out/i });
  if (found[0]) return found[0];
  throw new Error('No sign-out control found in AppNav');
}
