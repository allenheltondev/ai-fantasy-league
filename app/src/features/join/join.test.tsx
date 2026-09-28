import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { InvitePreview } from '../../api/types';
import { fakeApi } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { RETURN_KEY } from '../../auth/AuthScreens';
import { notJoinableReason } from './JoinPage';

const PREVIEW: InvitePreview = {
  leagueName: 'Sunday Funday',
  season: 2026,
  commissionerName: 'Alice',
  phase: 'setup',
  teamCount: 4,
  openSeats: 2,
  status: 'active',
  joinable: true
};

describe('join page', () => {
  it('sends a signed-out visitor to sign in first', async () => {
    const user = userEvent.setup();
    renderApp('/join/tok');
    expect(await screen.findByRole('heading', { name: 'Sunday Funday' })).toBeInTheDocument();
    expect(screen.getByText(/2 open seat/)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Sign in to join' }));
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('brings a new account back to the invite after sign-up, even if the router state is lost', async () => {
    const user = userEvent.setup();
    renderApp('/join/tok');
    await user.click(await screen.findByRole('link', { name: 'Create an account' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem(RETURN_KEY)).toBe('/join/tok');
    // Confirmation signs the new account in; a fresh /signup render has no router state.
    cleanup();
    signInAs({ sub: 'carol', given_name: 'Carol' });
    renderApp('/signup');
    expect(await screen.findByRole('button', { name: 'Join league' })).toBeInTheDocument();
    expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('joins with an optional team name and opens the league', async () => {
    const user = userEvent.setup();
    signInAs({ sub: 'bob', given_name: 'Bob' });
    const api = fakeApi();
    renderApp('/join/tok', undefined, api);
    await user.type(await screen.findByLabelText('Team name (optional)'), 'Bobcats');
    await user.click(screen.getByRole('button', { name: 'Join league' }));
    expect(await screen.findByTestId('league-section-settings')).toBeInTheDocument();
    expect(api.getInvite).toHaveBeenCalledWith('tok');
    expect(api.joinLeague).toHaveBeenCalledWith('tok', 'Bobcats');
  });

  it('shows join errors with their fix', async () => {
    const user = userEvent.setup();
    signInAs({ sub: 'bob' });
    const api = fakeApi({
      joinLeague: vi.fn(async () => {
        throw new ApiError(409, {
          code: 'ALREADY_A_MEMBER',
          message: 'You already have a seat in this league.',
          fix: 'Each person holds one seat per league.'
        });
      })
    });
    renderApp('/join/tok', undefined, api);
    await user.click(await screen.findByRole('button', { name: 'Join league' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Each person holds one seat per league.');
    expect(api.joinLeague).toHaveBeenCalledWith('tok', undefined);
  });

  it('explains an invite that cannot be used', async () => {
    renderApp(
      '/join/tok',
      undefined,
      fakeApi({ getInvite: vi.fn(async () => ({ ...PREVIEW, status: 'revoked' as const, joinable: false })) })
    );
    expect(await screen.findByText(/revoked this invite/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in to join' })).not.toBeInTheDocument();
  });

  it('shows an unknown invite as an error', async () => {
    renderApp(
      '/join/nope',
      undefined,
      fakeApi({
        getInvite: vi.fn(async () => {
          throw new ApiError(404, { code: 'INVITE_NOT_FOUND', message: 'This invite link is not valid.' });
        })
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('This invite link is not valid.');
  });

  it('gives a reason for every unusable invite', () => {
    const closed = { ...PREVIEW, joinable: false };
    expect(notJoinableReason(PREVIEW)).toBeNull();
    expect(notJoinableReason({ ...closed, status: 'expired' })).toMatch(/expired/);
    expect(notJoinableReason({ ...closed, status: 'used_up' })).toMatch(/used up/);
    expect(notJoinableReason({ ...closed, phase: 'drafting' })).toMatch(/draft/);
    expect(notJoinableReason({ ...closed, openSeats: 0 })).toMatch(/Every seat/);
  });
});
