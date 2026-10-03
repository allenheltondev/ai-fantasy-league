import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type { DepthChartPlayer, NflDepthChart, PointsAllowedData } from '../../api/types';
import type { PlayerCardData } from '../../draft/research';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { NflTeamPage } from './NflTeamPage';

/** An NFL team's page (League › Players): its depth chart, with links to each player's card. */

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

function player(id: string, extra: Partial<DepthChartPlayer> = {}): DepthChartPlayer {
  return {
    id,
    name: `Player ${id}`,
    team: 'KC',
    position: 'WR',
    depth: 1,
    number: null,
    injuryStatus: null,
    ...extra
  };
}

const KC: NflDepthChart = {
  team: { code: 'KC', city: 'Kansas City', nickname: 'Chiefs' },
  slots: [
    { slot: 'QB', label: 'QB', players: [player('qb1', { position: 'QB', number: 15 })] },
    {
      slot: 'LWR',
      label: 'WR (left)',
      players: [
        player('wr1'),
        player('wr2', { depth: 2, injuryStatus: 'Questionable' }),
        player('wr3', { depth: null })
      ]
    }
  ],
  others: [player('ir1', { position: 'RB', depth: null, injuryStatus: 'IR' })]
};

/** The player card loads through fetch (the league shell's card drawer). */
function stubCardFetch() {
  const card = (playerId: string): PlayerCardData => ({
    player: { id: playerId, name: `Player ${playerId}`, team: 'KC', position: 'QB' },
    scoring: { source: 'league' },
    bye: 10,
    injuryStatus: null,
    lastSeason: null,
    projection: null,
    thisSeason: null,
    nextWeek: null,
    news: []
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const data = url.pathname.endsWith('/players/card') ? card(url.searchParams.get('playerId') ?? '') : {};
      return new Response(JSON.stringify({ data, league: null, warnings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    })
  );
}

const rank = (perGame: number, r: number) => ({ perGame, rank: r, of: 32 });
const KC_ALLOWED: PointsAllowedData = {
  season: 2026,
  throughWeek: 3,
  scoring: 'ppr',
  teams: [
    {
      team: 'KC',
      games: 3,
      positions: {
        QB: rank(24.1, 2),
        RB: rank(18, 16),
        WR: rank(20.25, 31),
        TE: rank(8, 12),
        K: rank(9, 20),
        DEF: rank(4, 25)
      }
    }
  ]
};

function open(path: string, overrides: Partial<LeagueApi> = {}) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 3 })),
    getNflDepthChart: vi.fn(async () => KC),
    getPointsAllowed: vi.fn(async () => KC_ALLOWED),
    ...overrides
  });
  renderApp(path, undefined, api);
  return api;
}

beforeEach(() => {
  signInAs(ALICE);
  stubCardFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('NFL team page', () => {
  it('shows the depth chart starters first, with pictures, numbers and injuries', async () => {
    const api = open('/leagues/L1/league/players/nfl/kc');
    expect(await screen.findByRole('heading', { level: 2, name: 'Kansas City Chiefs' })).toBeInTheDocument();
    expect(api.getNflDepthChart).toHaveBeenCalledWith('KC');
    expect(document.title).toMatch(/^KC depth chart · /);
    const qb = screen.getByRole('region', { name: 'QB' });
    expect(within(qb).getByTestId('depth-qb1')).toHaveTextContent('1Player qb1#15');
    const wr = screen.getByRole('region', { name: 'WR (left)' });
    const rows = within(wr).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['1Player wr1', '2Player wr2Q', '–Player wr3']);
    const others = screen.getByRole('region', { name: 'Not on the depth chart' });
    expect(within(others).getByTestId('depth-ir1')).toHaveTextContent('Player ir1RB · IR');
    expect(screen.getByRole('link', { name: '← All players' })).toHaveAttribute(
      'href',
      '/leagues/L1/league/players'
    );
    expect(screen.getByLabelText('NFL team')).toHaveValue('KC');
  });

  it('shows the points its defense allows to each position, rated as a matchup', async () => {
    const api = open('/leagues/L1/league/players/nfl/KC');
    const section = await screen.findByRole('region', { name: 'Points allowed by position' });
    expect(api.getPointsAllowed).toHaveBeenCalledWith({ team: 'KC' });
    expect(section).toHaveTextContent('through week 3 (3 games)');
    expect(within(section).getByTestId('allowed-QB')).toHaveTextContent(
      'QB 24.1 pts · 2nd of 32Favorable matchup'
    );
    expect(within(section).getByTestId('allowed-RB')).toHaveTextContent(
      'RB 18 pts · 16th of 32Average matchup'
    );
    expect(within(section).getByTestId('allowed-WR')).toHaveTextContent(
      'WR 20.3 pts · 31st of 32Tough matchup'
    );
    expect(within(section).getByTestId('allowed-DEF')).toHaveTextContent('Team defense 4 pts');
  });

  it('counts a single game and leaves out a position the server did not rank', async () => {
    const { DEF: _def, ...positions } = KC_ALLOWED.teams[0]!.positions;
    open('/leagues/L1/league/players/nfl/KC', {
      getPointsAllowed: vi.fn(async () => ({
        ...KC_ALLOWED,
        throughWeek: 1,
        teams: [{ team: 'KC', games: 1, positions }]
      }))
    });
    const section = await screen.findByRole('region', { name: 'Points allowed by position' });
    expect(section).toHaveTextContent('through week 1 (1 game)');
    expect(within(section).queryByTestId('allowed-DEF')).toBeNull();
    expect(within(section).getByTestId('allowed-QB')).toBeInTheDocument();
  });

  it('says when there are no completed games yet', async () => {
    open('/leagues/L1/league/players/nfl/KC', {
      getPointsAllowed: vi.fn(async () => ({ ...KC_ALLOWED, throughWeek: null, teams: [] }))
    });
    expect(await screen.findByText('No completed games yet this season.')).toBeInTheDocument();
  });

  it('keeps the depth chart when points allowed cannot load', async () => {
    open('/leagues/L1/league/players/nfl/KC', {
      getPointsAllowed: vi.fn(async () => {
        throw new Error('down');
      })
    });
    expect(await screen.findByText('Points allowed are not available right now.')).toBeInTheDocument();
    expect(screen.getByTestId('depth-qb1')).toBeInTheDocument();
  });

  it("opens a player's card, whose team links back to the team page", async () => {
    const user = userEvent.setup();
    open('/leagues/L1/league/players/nfl/KC');
    await user.click(await screen.findByRole('button', { name: 'Player qb1' }));
    const card = await screen.findByTestId('player-card');
    const link = within(card).getByRole('link', { name: 'KC' });
    expect(link).toHaveAttribute('href', '/leagues/L1/league/players/nfl/KC');
    await user.click(link);
    await waitFor(() => expect(screen.queryByTestId('player-card')).not.toBeInTheDocument());
  });

  it("jumps to another team from the picker and shows that team's chart", async () => {
    const user = userEvent.setup();
    const BUF: NflDepthChart = {
      team: { code: 'BUF', city: 'Buffalo', nickname: 'Bills' },
      slots: [{ slot: 'QB', label: 'QB', players: [player('buf-qb', { team: 'BUF', position: 'QB' })] }],
      others: []
    };
    const api = open('/leagues/L1/league/players/nfl/KC', {
      getNflDepthChart: vi.fn(async (team: string) => (team === 'BUF' ? BUF : KC))
    });
    await screen.findByRole('heading', { level: 2, name: 'Kansas City Chiefs' });
    await user.selectOptions(screen.getByLabelText('NFL team'), 'BUF');
    expect(await screen.findByRole('heading', { level: 2, name: 'Buffalo Bills' })).toBeInTheDocument();
    expect(screen.getByTestId('depth-buf-qb')).toBeInTheDocument();
    expect(screen.queryByTestId('depth-qb1')).not.toBeInTheDocument();
    expect(api.getNflDepthChart).toHaveBeenCalledWith('BUF');
  });

  it("shows the error, not the last team's chart, when a switch fails", async () => {
    const user = userEvent.setup();
    let failBuf: (reason: Error) => void = () => undefined;
    // Rendered on its own: the league shell remounts each page by path, which would hide a stale chart.
    const api = fakeApi({
      getNflDepthChart: vi.fn((team: string) =>
        team === 'BUF'
          ? new Promise<NflDepthChart>((_, reject) => {
              failBuf = reject;
            })
          : Promise.resolve(KC)
      )
    });
    render(
      <LeagueApiContext.Provider value={api}>
        <MemoryRouter initialEntries={['/leagues/L1/league/players/nfl/KC']}>
          <Routes>
            <Route path="/leagues/:leagueId/league/players/nfl/:team" element={<NflTeamPage />} />
          </Routes>
        </MemoryRouter>
      </LeagueApiContext.Provider>
    );
    await screen.findByRole('heading', { level: 2, name: 'Kansas City Chiefs' });
    await user.selectOptions(screen.getByLabelText('NFL team'), 'BUF');
    // While Buffalo loads, Kansas City's chart is gone.
    expect(await screen.findByText('Loading the depth chart…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Kansas City Chiefs' })).not.toBeInTheDocument();
    failBuf(new Error('boom'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Kansas City Chiefs' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('NFL team')).toHaveValue('BUF');
  });

  it('says when a team has no depth chart yet, or the load fails', async () => {
    open('/leagues/L1/league/players/nfl/NYJ', {
      getNflDepthChart: vi.fn(async () => ({ ...KC, slots: [], others: [] }))
    });
    expect(await screen.findByText('No depth chart yet')).toBeInTheDocument();
  });

  it('shows why the depth chart could not load', async () => {
    open('/leagues/L1/league/players/nfl/KC', {
      getNflDepthChart: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('handles a code that is not an NFL team without calling the server', async () => {
    const api = open('/leagues/L1/league/players/nfl/XYZ');
    expect(await screen.findByText('Team not found')).toBeInTheDocument();
    expect(screen.getByLabelText('NFL team')).toHaveValue('');
    expect(api.getNflDepthChart).not.toHaveBeenCalled();
  });
});
