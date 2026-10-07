import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { renderApp, signInAs } from '../../test/render';
import type { LeagueOutletContext } from '../../routes/leagueContext';
import { state } from '../../test/fakeApi';
import { MatchupHelp, MovesHelp, PlayersHelp, PlayoffsHelp, StandingsHelp, TradesHelp } from './PageHelp';

/** A help panel inside league L1, with the layout's league state. */
function renderHelp(
  help: ReactNode,
  overrides: { allowedActions?: string[]; youAreCommissioner?: boolean } = {}
) {
  const context: LeagueOutletContext = {
    yourTeamId: 'team-1',
    phase: 'regular_season',
    state: state({ phase: 'regular_season', week: 3, youAreCommissioner: false, ...overrides }),
    reloadLeague: () => undefined
  };
  return render(
    <MemoryRouter initialEntries={['/leagues/L1/here']}>
      <Routes>
        <Route path="/leagues/:leagueId" element={<Outlet context={context} />}>
          <Route path="here" element={help} />
          <Route path="*" element={<p>Somewhere else</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

async function openPanel(button: string, panel: string) {
  await userEvent.setup().click(screen.getByRole('button', { name: button }));
  return screen.getByRole('region', { name: panel });
}

const hrefs = (panel: HTMLElement) =>
  Object.fromEntries(
    within(panel)
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')])
  );

describe('page help', () => {
  it.each([
    [
      'Roster & moves',
      <MovesHelp waiverType="rolling" />,
      'How do adds and drops work?',
      'Adds and drops help',
      {
        Lineup: '/leagues/L1/team/lineup',
        Players: '/leagues/L1/league/players',
        Trades: '/leagues/L1/team/trades',
        'League info': '/leagues/L1/settings'
      }
    ],
    [
      'Players',
      <PlayersHelp />,
      'How do I read this list?',
      'Players help',
      {
        'Roster & moves': '/leagues/L1/team/moves',
        Trades: '/leagues/L1/team/trades',
        'League info': '/leagues/L1/settings'
      }
    ],
    [
      'Trades',
      <TradesHelp />,
      'How trades work',
      'Trades help',
      {
        'Other teams': '/leagues/L1/team/teams',
        Players: '/leagues/L1/league/players',
        'Roster & moves': '/leagues/L1/team/moves',
        'League info': '/leagues/L1/settings'
      }
    ],
    [
      'Matchup',
      <MatchupHelp />,
      'How matchups work',
      'Matchup help',
      {
        Lineup: '/leagues/L1/team/lineup',
        Scoreboard: '/leagues/L1/league/scoreboard',
        Standings: '/leagues/L1/league/standings',
        'League info': '/leagues/L1/settings'
      }
    ],
    [
      'Standings',
      <StandingsHelp />,
      'How are standings decided?',
      'Standings help',
      {
        Playoffs: '/leagues/L1/league/playoffs',
        Scoreboard: '/leagues/L1/league/scoreboard',
        'League info': '/leagues/L1/settings'
      }
    ],
    [
      'Playoffs',
      <PlayoffsHelp />,
      'How the playoffs work',
      'Playoffs help',
      {
        Standings: '/leagues/L1/league/standings',
        'My matchup': '/leagues/L1/team/matchup',
        'League info': '/leagues/L1/settings'
      }
    ]
  ])(
    '%s: opens from its button and links where the related moves happen',
    async (_, help, button, panel, links) => {
      renderHelp(help, { allowedActions: ['set_lineup', 'claim_waiver', 'propose_trade'] });
      expect(screen.queryByRole('region', { name: panel })).toBeNull();
      expect(hrefs(await openPanel(button, panel))).toEqual(links);
    }
  );

  it('leaves out trades when they are closed, and calls the rules Settings for the commissioner', async () => {
    renderHelp(<MovesHelp waiverType="faab" />, { allowedActions: ['set_lineup'], youAreCommissioner: true });
    const panel = await openPanel('How do adds and drops work?', 'Adds and drops help');
    expect(within(panel).queryByRole('link', { name: 'Trades' })).toBeNull();
    expect(within(panel).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/leagues/L1/settings'
    );
  });

  it('explains the league’s own kind of waivers', async () => {
    const { unmount } = renderHelp(<MovesHelp waiverType="rolling" />);
    expect(await openPanel('How do adds and drops work?', 'Adds and drops help')).toHaveTextContent(
      'waiver priority list'
    );
    unmount();
    renderHelp(<MovesHelp waiverType="faab" />);
    const faab = await openPanel('How do adds and drops work?', 'Adds and drops help');
    expect(faab).toHaveTextContent('highest FAAB bid wins');
    expect(faab).not.toHaveTextContent('priority list');
  });

  it('takes you to the page a link names', async () => {
    renderHelp(<PlayoffsHelp />);
    const panel = await openPanel('How the playoffs work', 'Playoffs help');
    await userEvent.setup().click(within(panel).getByRole('link', { name: 'Standings' }));
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Playoffs help' })).toBeNull();
  });
});

describe('page help on its page', () => {
  it.each([
    ['team/matchup', 'How matchups work'],
    ['team/trades', 'How trades work'],
    ['league/players', 'How do I read this list?'],
    ['league/playoffs', 'How the playoffs work']
  ])('%s offers its help', async (page, button) => {
    signInAs({ sub: 'alice', email: 'alice@example.com', given_name: 'Alice' });
    renderApp(`/leagues/L1/${page}`);
    expect(await screen.findByRole('button', { name: button })).toBeInTheDocument();
  });
});
