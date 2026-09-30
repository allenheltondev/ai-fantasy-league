import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyLeague } from '../../api/types';
import { fakeApi } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { leagueHref, weekLabel } from './MyLeaguesPage';

function myLeague(overrides: Partial<MyLeague>): MyLeague {
  return {
    id: 'L1',
    name: 'Sunday Funday',
    season: 2026,
    phase: 'setup',
    week: null,
    teamCount: 8,
    startWeek: 4,
    commissionerName: 'Alice',
    youAreCommissioner: true,
    yourTeamId: 'team-1',
    record: null,
    ...overrides
  };
}

beforeEach(() => signInAs({ sub: 'alice', given_name: 'Alice' }));

describe('My Leagues', () => {
  it('lists leagues with phase, week, and record', async () => {
    const api = fakeApi({
      listMyLeagues: vi.fn(async () => [
        myLeague({}),
        myLeague({
          id: 'L2',
          name: 'Work League',
          phase: 'regular_season',
          week: 6,
          record: '4-1',
          youAreCommissioner: false
        })
      ])
    });
    renderApp('/', undefined, api);
    const list = await screen.findByRole('list', { name: 'Leagues' });
    const [setup, season] = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(within(setup).getByRole('link', { name: 'Sunday Funday' })).toHaveAttribute(
      'href',
      '/leagues/L1/settings'
    );
    expect(setup).toHaveTextContent('Setup');
    expect(setup).toHaveTextContent('Starts week 4');
    expect(setup).toHaveTextContent('Record: —');
    expect(setup).toHaveTextContent('Commissioner');
    expect(within(season).getByRole('link', { name: 'Work League' })).toHaveAttribute('href', '/leagues/L2');
    expect(season).toHaveTextContent('Regular season');
    expect(season).toHaveTextContent('Week 6');
    expect(season).toHaveTextContent('Record: 4-1');
    expect(season).not.toHaveTextContent('Commissioner');
    expect(screen.getByRole('link', { name: 'Create a league' })).toHaveAttribute('href', '/leagues/new');
  });

  it('shows the empty state with a Create button', async () => {
    renderApp('/');
    expect(await screen.findByText('No leagues yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a league' })).toHaveAttribute('href', '/leagues/new');
  });

  it('joins a league by code from the empty state', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderApp('/', undefined, api);
    await user.click(await screen.findByRole('button', { name: 'Join a league' }));
    // Typed any way: lowercase, with a dash and stray spaces.
    await user.type(screen.getByLabelText('Join code'), ' k7m-q2x ');
    await user.click(screen.getByRole('button', { name: 'Find league' }));
    expect(await screen.findByRole('heading', { name: 'Sunday Funday' })).toBeInTheDocument();
    expect(api.getInvite).toHaveBeenCalledWith('K7MQ2X');
  });

  it('offers Join a league next to Create when you already have leagues, and rejects a malformed code', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ listMyLeagues: vi.fn(async () => [myLeague({})]) });
    renderApp('/leagues', undefined, api);
    await user.click(await screen.findByRole('button', { name: 'Join a league' }));
    expect(screen.getByRole('link', { name: 'Create a league' })).toBeInTheDocument();
    const input = screen.getByLabelText('Join code');
    // 0, O, 1, I and L are never in a code, so these cannot be one.
    await user.type(input, 'HELLO0');
    await user.click(screen.getByRole('button', { name: 'Find league' }));
    expect(
      await screen.findByText('A join code is 6 letters and numbers, like K7M-Q2X.')
    ).toBeInTheDocument();
    expect(api.getInvite).not.toHaveBeenCalled();
    await user.type(input, '{Backspace}');
    expect(screen.queryByText(/A join code is 6/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Join a league' })).toBeInTheDocument();
  });

  it('shows an error with a retry', async () => {
    const user = userEvent.setup();
    const listMyLeagues = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
    renderApp('/', undefined, fakeApi({ listMyLeagues }));
    expect(await screen.findByText('offline')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No leagues yet')).toBeInTheDocument();
  });

  it('labels weeks and picks where a league opens', () => {
    expect(weekLabel({ week: null, startWeek: 3 })).toBe('Starts week 3');
    expect(weekLabel({ week: 9, startWeek: 3 })).toBe('Week 9');
    expect(leagueHref({ id: 'X', phase: 'drafting' })).toBe('/leagues/X');
  });
});
