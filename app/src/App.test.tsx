import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { safeReturnPath } from './auth/AuthScreens';
import { activeNavId, displayName } from './layout/AppLayout';
import { fakeApi, league } from './test/fakeApi';
import { renderApp, signInAs } from './test/render';

const ALICE = { sub: 'u1', email: 'alice@example.com', given_name: 'Alice', family_name: 'Smith' };

describe('signed out', () => {
  it('redirects a protected route to the sign-in form', async () => {
    renderApp('/leagues/L1/roster');
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
    expect(screen.getByRole('link', { name: /create an account/i })).toHaveAttribute('href', '/signup');
    expect(screen.queryByTestId('auth-not-configured')).not.toBeInTheDocument();
  });

  it('warns when this environment has no sign-in config', async () => {
    renderApp('/login', null);
    expect(await screen.findByTestId('auth-not-configured')).toBeInTheDocument();
  });

  it('moves between the sign-in, sign-up and forgot-password flows', async () => {
    const user = userEvent.setup();
    renderApp('/login');
    await user.click(await screen.findByRole('link', { name: /create an account/i }));
    const signIn = await screen.findByRole('link', { name: /^sign in$/i });
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    await user.click(signIn);
    await user.click(await screen.findByRole('link', { name: /forgot password/i }));
    await user.click(await screen.findByRole('link', { name: /back to sign in/i }));
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders the confirm step at /signup/confirm', async () => {
    renderApp('/signup/confirm');
    expect(await screen.findByRole('link', { name: /^sign in$/i })).toBeInTheDocument();
  });
});

describe('signed in', () => {
  it('shows the shell with AppNav and My Leagues', async () => {
    signInAs(ALICE);
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'My Leagues' })).toBeInTheDocument();
    expect(screen.getAllByText('AI Fantasy Football').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Create League' }).length).toBeGreaterThan(0);
  });

  it('bounces a signed-in visitor away from /login to where they were going', async () => {
    signInAs(ALICE);
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: 'My Leagues' })).toBeInTheDocument();
  });

  it('renders the create league page', async () => {
    signInAs(ALICE);
    renderApp('/leagues/new');
    expect(await screen.findByRole('heading', { name: 'Create League' })).toBeInTheDocument();
  });

  it('opens a league on its Home dashboard with the league side nav (#178)', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1');
    expect(await screen.findByTestId('league-section-home')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Draft' })).toBeInTheDocument();
    // The header bar names the league and the side nav the page, so the page's h1 is for screen
    // readers only, named after the page (#212).
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toHaveClass('sr-only');
    expect(screen.queryByRole('heading', { name: 'Sunday Funday' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Home · Sunday Funday · AI Fantasy Football'));
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const link = (name: string) => within(nav).getByRole('link', { name });
    expect(link('Home')).toHaveAttribute('aria-current', 'page');
    expect(link('My Leagues')).toHaveAttribute('href', '/leagues');
    // In setup the Draft is its own section.
    expect(link('Draft')).toHaveAttribute('href', '/leagues/L1/draft');
    for (const [name, page] of [
      ['Scoreboard', 'scoreboard'],
      ['Standings', 'standings'],
      ['Playoffs', 'playoffs'],
      ['Transactions', 'transactions'],
      ['Players', 'players']
    ] as const) {
      expect(link(name)).toHaveAttribute('href', `/leagues/L1/league/${page}`);
    }
    expect(link('Chat')).toHaveAttribute('href', '/leagues/L1/chat');
    expect(link('Settings')).toHaveAttribute('href', '/leagues/L1/settings');
    for (const [name, page] of [
      ['Lineup', 'lineup'],
      ['Matchup', 'matchup'],
      ['Roster & moves', 'moves'],
      ['Trades', 'trades'],
      ['Achievements', 'achievements'],
      ['Team profile', 'profile'],
      ['Other teams', 'teams']
    ] as const) {
      expect(link(name)).toHaveAttribute('href', `/leagues/L1/team/${page}`);
    }
    const headings = [...nav.querySelectorAll('.app-nav-section-title')].map((h) => h.textContent);
    expect(headings).toEqual(['League', 'My Team']);
    // The header bar switches leagues; the side nav carries the sections, so it has no links.
    expect(screen.getByLabelText('League')).toHaveValue('L1');
  });

  it('lists My Leagues and Create League outside a league', async () => {
    signInAs(ALICE);
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Primary navigation' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent)
    ).toEqual(['My Leagues', 'Create League']);
    expect(screen.queryByLabelText('League')).not.toBeInTheDocument();
  });

  it('navigates between league sections', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    renderApp('/leagues/L1/draft');
    expect(await screen.findByTestId('league-section-draft')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    await user.click(within(nav).getByRole('link', { name: 'Trades' }));
    expect(await screen.findByTestId('league-section-trades')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Trades' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: 'Scoreboard' }));
    expect(await screen.findByTestId('league-page-scoreboard')).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Standings' }));
    expect(await screen.findByTestId('league-section-standings')).toBeInTheDocument();
  });

  it.each([
    ['/leagues/L1/roster', 'league-section-roster'],
    ['/leagues/L1/matchup', 'league-section-matchup'],
    ['/leagues/L1/trades?trade=t1', 'league-section-trades'],
    ['/leagues/L1/players', 'league-section-players'],
    ['/leagues/L1/standings', 'league-section-standings'],
    ['/leagues/L1/standings?view=playoffs', 'league-page-playoffs'],
    ['/leagues/L1/standings?view=history', 'league-section-settings'],
    ['/leagues/L1/team', 'league-section-roster'],
    ['/leagues/L1/league', 'league-page-scoreboard']
  ])('keeps the deep link %s working', async (path, testId) => {
    signInAs(ALICE);
    renderApp(path);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it('shows the draft results in League info once the draft is over', async () => {
    signInAs(ALICE);
    renderApp(
      '/leagues/L1/settings?view=draft',
      undefined,
      fakeApi({ getLeague: vi.fn(async () => league({ phase: 'regular_season' })) })
    );
    expect(await screen.findByTestId('league-section-draft')).toBeInTheDocument();
  });

  it('shows not found for an unknown path', async () => {
    signInAs(ALICE);
    renderApp('/nowhere');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('safeReturnPath keeps in-app paths only', () => {
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('/login')).toBe('/');
    expect(safeReturnPath('/signup/confirm')).toBe('/');
    expect(safeReturnPath('/leagues/L1/draft?x=1')).toBe('/leagues/L1/draft?x=1');
  });

  it('displayName prefers the name, then the email', () => {
    expect(displayName(ALICE)).toBe('Alice Smith');
    expect(displayName({ email: 'bob@example.com' })).toBe('bob@example.com');
    expect(displayName({})).toBeUndefined();
  });

  it('activeNavId maps paths to top-level items', () => {
    expect(activeNavId('/')).toBe('leagues');
    expect(activeNavId('/leagues/L1/draft')).toBe('leagues');
    expect(activeNavId('/leagues/new')).toBe('create');
    expect(activeNavId('/elsewhere')).toBeNull();
  });
});
