import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './auth/AuthScreens';
import { activeNavId, displayName } from './layout/AppLayout';
import { LEAGUE_SECTIONS } from './routes/pages';
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
    expect(screen.getAllByText('Fantasy').length).toBeGreaterThan(0);
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

  it('redirects a league to its matchup and lists every section', async () => {
    signInAs(ALICE);
    renderApp('/leagues/L1');
    expect(await screen.findByTestId('league-section-matchup')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'League sections' });
    for (const section of LEAGUE_SECTIONS) {
      expect(within(nav).getByRole('link', { name: section.label })).toHaveAttribute(
        'href',
        `/leagues/L1/${section.path}`
      );
    }
  });

  it('navigates between league sections', async () => {
    const user = userEvent.setup();
    signInAs(ALICE);
    renderApp('/leagues/L1/draft');
    expect(await screen.findByTestId('league-section-draft')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Trades' }));
    expect(await screen.findByTestId('league-section-trades')).toBeInTheDocument();
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
