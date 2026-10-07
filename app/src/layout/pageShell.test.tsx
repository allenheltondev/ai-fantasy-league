import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MyLeague } from '../api/types';
import { LAST_LEAGUE_KEY } from '../routes/lastLeague';
import { fakeApi } from '../test/fakeApi';
import { renderApp, signInAs } from '../test/render';

/**
 * The shell's side of #212: no page repeats the league's name (the header bar has it) or the
 * nav item it is under, each keeps exactly one h1, the tab says where you are, and `/` takes you
 * back into the league you last opened.
 */

const ALICE = { sub: 'u1', email: 'alice@example.com', given_name: 'Alice' };

const mine = (id: string, name: string): MyLeague => ({
  id,
  name,
  season: 2026,
  phase: 'regular_season',
  week: 3,
  teamCount: 4,
  startWeek: 1,
  commissionerName: 'Alice',
  youAreCommissioner: true,
  yourTeamId: 'team-1',
  record: '2-0'
});

const h1s = () => screen.getAllByRole('heading', { level: 1 });

describe('league pages (#212)', () => {
  it.each([
    ['/leagues/L1/home', 'league-section-home', 'Home'],
    ['/leagues/L1/chat', 'league-section-chat', 'Chat'],
    ['/leagues/L1/team/matchup', 'league-section-matchup', 'Matchup'],
    ['/leagues/L1/team/lineup', 'league-section-roster', 'My Team'],
    ['/leagues/L1/team/moves', 'team-page-moves', 'Roster & moves'],
    ['/leagues/L1/team/trades', 'league-section-trades', 'Trades'],
    ['/leagues/L1/league/scoreboard', 'league-page-scoreboard', 'Scoreboard'],
    ['/leagues/L1/league/standings', 'league-section-standings', 'Standings'],
    ['/leagues/L1/draft', 'league-section-draft', 'Draft'],
    ['/leagues/L1/settings', 'league-section-settings', 'Settings']
  ])('%s has one h1, for screen readers, and no league-name heading', async (path, testId, name) => {
    signInAs(ALICE);
    renderApp(path);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
    // The league's name reaches the header bar's switcher...
    await waitFor(() => expect(document.title).toContain('Sunday Funday'));
    // ...and no heading on the page repeats it.
    expect(screen.queryByRole('heading', { name: 'Sunday Funday' })).not.toBeInTheDocument();
    expect(h1s()).toHaveLength(1);
    expect(h1s()[0]).toHaveTextContent(name);
    expect(h1s()[0]).toHaveClass('sr-only');
    // No section heading repeats the nav item's name either (Roster & moves is #205's to trim).
    if (name !== 'Roster & moves') {
      expect(screen.getAllByRole('heading', { name })).toHaveLength(1);
    }
    expect(document.title).toBe(`${name} · Sunday Funday · AI Fantasy Football`);
  });

  it("names another team's page after its section, with the team on screen and in the tab", async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/team/teams/team-2');
    expect(await screen.findByRole('heading', { level: 2, name: "Bob's Team" })).toBeVisible();
    expect(h1s()).toHaveLength(1);
    expect(h1s()[0]).toHaveTextContent('My Team');
    await waitFor(() => expect(document.title).toBe("Bob's Team · Sunday Funday · AI Fantasy Football"));
  });

  it('keeps the league settings facts that the nav does not say', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/settings');
    const page = await screen.findByTestId('league-section-settings');
    expect(within(page).getByText('You are the commissioner')).toBeInTheDocument();
  });

  it('changes the tab title as you move around, and restores it when you sign out', async () => {
    const user = userEvent.setup();
    document.title = 'AI Fantasy Football';
    signInAs(ALICE);
    const view = renderApp('/leagues/L1/home');
    await waitFor(() => expect(document.title).toBe('Home · Sunday Funday · AI Fantasy Football'));
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    await user.click(within(nav).getByRole('link', { name: 'Chat' }));
    await waitFor(() => expect(document.title).toBe('Chat · Sunday Funday · AI Fantasy Football'));
    await user.click(within(nav).getByRole('link', { name: 'My Leagues' }));
    await waitFor(() => expect(document.title).toBe('My Leagues · AI Fantasy Football'));
    view.unmount();
    expect(document.title).toBe('AI Fantasy Football');
  });
});

describe('the last league (#212)', () => {
  it('remembers a league once it opens', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1/home');
    await screen.findByTestId('league-section-home');
    await waitFor(() => expect(localStorage.getItem(LAST_LEAGUE_KEY)).toBe('L1'));
  });

  it('sends / straight back into the last league while you are still in it', async () => {
    signInAs(ALICE);
    localStorage.setItem(LAST_LEAGUE_KEY, 'L1');
    renderApp('/', undefined, fakeApi({ listMyLeagues: vi.fn(async () => [mine('L1', 'Sunday Funday')]) }));
    expect(await screen.findByTestId('league-section-home')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'My Leagues' })).not.toBeInTheDocument();
  });

  it('forgets a league you are no longer in and shows My Leagues', async () => {
    signInAs(ALICE);
    localStorage.setItem(LAST_LEAGUE_KEY, 'gone');
    renderApp('/', undefined, fakeApi({ listMyLeagues: vi.fn(async () => [mine('L1', 'Sunday Funday')]) }));
    expect(await screen.findByRole('heading', { level: 1, name: 'My Leagues' })).toBeVisible();
    // Forgotten in an effect once the list says you are not a member: wait for it, don't race it.
    await waitFor(() => expect(localStorage.getItem(LAST_LEAGUE_KEY)).toBeNull());
  });

  it('shows My Leagues at / with nothing remembered', async () => {
    signInAs(ALICE);
    const api = fakeApi({ listMyLeagues: vi.fn(async () => [mine('L1', 'Sunday Funday')]) });
    renderApp('/', undefined, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'My Leagues' })).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Sunday Funday' }).length).toBeGreaterThan(0);
  });

  it('keeps the league remembered when the list cannot load, and shows that error', async () => {
    signInAs(ALICE);
    localStorage.setItem(LAST_LEAGUE_KEY, 'L1');
    renderApp(
      '/',
      undefined,
      fakeApi({ listMyLeagues: vi.fn(async () => Promise.reject(new Error('down'))) })
    );
    expect(await screen.findByText('Could not load your leagues')).toBeInTheDocument();
    expect(localStorage.getItem(LAST_LEAGUE_KEY)).toBe('L1');
  });

  it('never bounces /leagues (My Leagues in the nav) into a league', async () => {
    signInAs(ALICE);
    localStorage.setItem(LAST_LEAGUE_KEY, 'L1');
    renderApp(
      '/leagues',
      undefined,
      fakeApi({ listMyLeagues: vi.fn(async () => [mine('L1', 'Sunday Funday')]) })
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'My Leagues' })).toBeVisible();
    expect((await screen.findAllByRole('link', { name: 'Sunday Funday' })).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('league-section-home')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByRole('link', { name: 'My Leagues' })).toHaveAttribute('aria-current', 'page');
  });
});
