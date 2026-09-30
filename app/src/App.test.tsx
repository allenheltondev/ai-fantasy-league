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
    // The side nav names the league and the page, so the page's h1 is for screen readers only,
    // named after the page (#212).
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toHaveClass('sr-only');
    expect(screen.queryByRole('heading', { name: 'Sunday Funday' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Home · Sunday Funday · AI Fantasy Football'));
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const link = (name: string) => within(nav).getByRole('link', { name });
    expect(link('Home')).toHaveAttribute('aria-current', 'page');
    expect(link('My Leagues')).toHaveAttribute('href', '/leagues');
    // In setup the Draft is its own section.
    expect(link('Draft')).toHaveAttribute('href', '/leagues/L1/draft');
    // One item per job; the pages under it are tabs on the page.
    for (const [name, page] of [
      ['Lineup', 'team/lineup'],
      ['Matchup', 'team/matchup'],
      ['Moves', 'team/moves'],
      ['Standings', 'league/standings'],
      ['Players', 'league/players'],
      ['Chat', 'chat'],
      ['Teams', 'team/profile'],
      ['Settings', 'settings']
    ] as const) {
      expect(link(name)).toHaveAttribute('href', `/leagues/L1/${page}`);
    }
    for (const name of ['Scoreboard', 'Playoffs', 'Transactions', 'Trades', 'Achievements', 'Other teams']) {
      expect(within(nav).queryByRole('link', { name })).not.toBeInTheDocument();
    }
    // The league's items sit under its name: there is no league switcher over the page.
    const headings = [...nav.querySelectorAll('.app-nav-section-title')].map((h) => h.textContent);
    expect(headings).toEqual(['Sunday Funday']);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
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
    await user.click(within(nav).getByRole('link', { name: 'Moves' }));
    expect(await screen.findByTestId('team-page-moves')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Moves' })).toHaveAttribute('aria-current', 'page');
    // The item's other pages are tabs over the page, and the item stays current on them.
    const tabs = screen.getByRole('navigation', { name: 'Moves pages' });
    expect(within(tabs).getByRole('link', { name: 'Roster & moves' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await user.click(within(tabs).getByRole('link', { name: 'Trades' }));
    expect(await screen.findByTestId('league-section-trades')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Moves' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: 'Matchup' }));
    const matchupTabs = await screen.findByRole('navigation', { name: 'Matchup pages' });
    await user.click(within(matchupTabs).getByRole('link', { name: 'Scoreboard' }));
    expect(await screen.findByTestId('league-page-scoreboard')).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Standings' }));
    expect(await screen.findByTestId('league-section-standings')).toBeInTheDocument();
    // A page alone under its item has no tabs.
    await user.click(within(nav).getByRole('link', { name: 'Chat' }));
    expect(await screen.findByTestId('league-section-chat')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /pages$/ })).not.toBeInTheDocument();
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
