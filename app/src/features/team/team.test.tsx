import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { DashboardMatchup, Roster, RosterEntry } from '../../api/types';
import { dashboard, fakeApi, state, team } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

/** My Team (#178): your team's profile and moves, and the other teams, read-only. */

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

const TEAMS = [
  team(1, { name: "Alice's Team", seatType: 'human', open: false, ownerName: 'Alice', ownerUserId: 'alice' }),
  team(2, {
    name: "Bob's Team",
    seatType: 'human',
    open: false,
    ownerName: 'Bob',
    ownerUserId: 'bob',
    avatarSeed: 'bob-seed'
  }),
  team(3, { name: 'Robots', manager: { name: 'Mei Park', avatarSeed: 'mei', personality: 'The Oracle' } })
];

const inSeason = (allowed = ['rename_team', 'propose_trade']) =>
  state({ phase: 'regular_season', week: 3, allowedActions: allowed, teams: TEAMS, yourTeam: TEAMS[0] });

function entry(id: string, slot: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    player: { id, name: `Player ${id}`, team: 'KC', position: 'WR' },
    slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: 10,
    onBye: false,
    kickoff: null,
    opponent: { team: 'DEN', home: true },
    locked: false,
    projectedPoints: 12.34,
    points: null,
    ...extra
  };
}

const bobRoster: Roster = {
  teamId: 'team-2',
  teamName: "Bob's Team",
  week: 3,
  lineupSaved: true,
  carriedFromWeek: null,
  slots: [],
  projectedPoints: 98.6,
  players: [
    entry('bench', 'BN', { projectedPoints: null }),
    entry('wr1', 'WR', { status: 'out', injuryStatus: 'Out' })
  ]
};

/** Waiver claims and the transaction log come straight from fetch (the players page's client). */
function stubFetch() {
  const json = (data: unknown) =>
    new Response(JSON.stringify({ data, league: null, warnings: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  const move = (id: string, teamId: string, teamName: string, name: string) => ({
    id,
    at: '2026-09-20T12:00:00.000Z',
    week: 3,
    type: 'add',
    teamId,
    teamName,
    added: { id, name, team: 'NYJ', position: 'RB' },
    dropped: null,
    cost: null
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '');
      if (path.endsWith('/waivers/claims')) return json({ claims: [] });
      if (path.endsWith('/transactions')) {
        return json({
          transactions: [
            move('m1', 'team-1', "Alice's Team", 'Breece Hall'),
            move('m2', 'team-2', "Bob's Team", 'Zach Charbonnet')
          ],
          nextCursor: null
        });
      }
      return json({});
    })
  );
}

function open(path: string, overrides: Partial<LeagueApi> = {}) {
  const api = fakeApi({ getLeagueState: vi.fn(async () => inSeason()), ...overrides });
  renderApp(path, undefined, api);
  return api;
}

beforeEach(() => {
  signInAs(ALICE);
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('My Team › Team profile', () => {
  it('renames the team and rolls a new avatar, then saves both with rename_team', async () => {
    const user = userEvent.setup();
    const api = open('/leagues/L1/team/profile');
    const name = await screen.findByLabelText('Team name');
    expect(name).toHaveValue("Alice's Team");
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'Gridiron Gang');
    await user.click(screen.getByRole('button', { name: 'New avatar' }));
    expect(screen.getByRole('img', { name: 'Gridiron Gang avatar' })).toBeInTheDocument();
    await user.click(save);

    await waitFor(() => expect(api.setTeamProfile).toHaveBeenCalledOnce());
    const [leagueId, teamId, profile] = vi.mocked(api.setTeamProfile).mock.calls[0]!;
    expect([leagueId, teamId, profile.name]).toEqual(['L1', 'team-1', 'Gridiron Gang']);
    expect(profile.avatarSeed).toMatch(/^[a-z0-9]{10}$/);
    expect(await screen.findByText('Team profile saved.')).toBeInTheDocument();
    // The shell reads the league again, so the new name and avatar show everywhere.
    await waitFor(() => expect(api.getLeagueState).toHaveBeenCalledTimes(2));
  });

  it('sends only what changed, and can undo', async () => {
    const user = userEvent.setup();
    const api = open('/leagues/L1/team/profile');
    await user.click(await screen.findByRole('button', { name: 'New avatar' }));
    await user.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'New avatar' }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.setTeamProfile).toHaveBeenCalledOnce());
    expect(Object.keys(vi.mocked(api.setTeamProfile).mock.calls[0]![2])).toEqual(['avatarSeed']);
  });

  it('shows why a save failed', async () => {
    const user = userEvent.setup();
    open('/leagues/L1/team/profile', {
      setTeamProfile: vi.fn(async () => {
        throw new Error('Another team is already named "Robots".');
      })
    });
    const name = await screen.findByLabelText('Team name');
    await user.clear(name);
    await user.type(name, 'Robots');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('is read-only once the league cannot change, and says so without a team', async () => {
    open('/leagues/L1/team/profile', { getLeagueState: vi.fn(async () => inSeason([])) });
    expect(await screen.findByLabelText('Team name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New avatar' })).toBeDisabled();
    expect(screen.getByText(/can no longer change/)).toBeInTheDocument();
  });

  it('has nothing to edit without a team', async () => {
    open('/leagues/L1/team/profile', {
      getLeagueState: vi.fn(async () => state({ yourTeam: null, teams: TEAMS }))
    });
    expect(await screen.findByText('No team')).toBeInTheDocument();
  });
});

describe('My Team › Roster & moves', () => {
  it('shows your claims and only your moves, with the player pool a tap away', async () => {
    open('/leagues/L1/team/moves');
    const moves = await screen.findByRole('region', { name: 'Your moves' });
    // The player's name is its own (clickable) element: match the move by its whole line.
    expect(
      await within(moves).findByText(
        (_, el) => el?.tagName === 'LI' && /added Breece Hall/.test(el.textContent ?? '')
      )
    ).toBeInTheDocument();
    expect(within(moves).queryByText(/Zach Charbonnet/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'My claims' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a player' })).toHaveAttribute(
      'href',
      '/leagues/L1/league/players'
    );
  });
});

describe('My Team › Achievements', () => {
  it('waits for the league before showing your team', async () => {
    open('/leagues/L1/team/achievements', {
      getLeagueState: vi.fn(() => new Promise<never>(() => undefined))
    });
    expect(await screen.findByText('Loading your team…')).toBeInTheDocument();
  });
});

describe('My Team › Other teams', () => {
  it('lists every other team with its picture, manager and record', async () => {
    open('/leagues/L1/team/teams', {
      getStandings: vi.fn(async () => ({
        throughWeek: 2,
        standings: [
          {
            rank: 1,
            teamId: 'team-3',
            teamName: 'Robots',
            record: '2-0',
            pointsFor: 1,
            pointsAgainst: 1,
            streak: null
          }
        ]
      }))
    });
    const list = await screen.findByRole('list', { name: 'Teams' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/leagues/L1/team/teams/team-2',
      '/leagues/L1/team/teams/team-3'
    ]);
    expect(within(links[0]!).getByRole('img', { name: "Bob's Team avatar" })).toBeInTheDocument();
    expect(links[1]).toHaveTextContent('Mei Park');
    expect(await within(links[1]!).findByText('2-0')).toBeInTheDocument();
    expect(within(list).queryByText("Alice's Team")).not.toBeInTheDocument();
  });

  it('says when the league has no one else yet', async () => {
    open('/leagues/L1/team/teams', {
      getLeagueState: vi.fn(async () => ({ ...inSeason(), teams: [TEAMS[0]!] }))
    });
    expect(await screen.findByText('No other teams')).toBeInTheDocument();
  });
});

describe('another team, read-only', () => {
  it("shows the team's lineup, projections and moves, with Propose trade the only action", async () => {
    const api = open('/leagues/L1/team/teams/team-2', { getRoster: vi.fn(async () => bobRoster) });
    expect(await screen.findByRole('heading', { level: 2, name: "Bob's Team" })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: "Bob's Team avatar" })).toBeInTheDocument();
    const lineup = await screen.findByRole('table', { name: "Bob's Team lineup" });
    const rows = within(lineup).getAllByRole('row');
    // Starters first; the bench after.
    expect(rows[1]).toHaveTextContent('WRPlayer wr1WR · KCOutvs DEN12.3');
    expect(rows[2]).toHaveTextContent('BNPlayer bench');
    expect(screen.getByText('Projected 98.6')).toBeInTheDocument();
    expect(api.getRoster).toHaveBeenCalledWith('L1', 'team-2');
    const moves = screen.getByRole('region', { name: 'Recent moves' });
    expect(await within(moves).findByText(/Zach Charbonnet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Propose trade' })).toHaveAttribute(
      'href',
      '/leagues/L1/team/trades?with=team-2'
    );
    // Read-only: nothing on the page changes the team.
    expect(screen.queryByRole('button', { name: /save|optimize|drop|add/i })).not.toBeInTheDocument();
  });

  it('offers no trade when trading is closed, and handles an unknown team', async () => {
    open('/leagues/L1/team/teams/team-3', {
      getLeagueState: vi.fn(async () => inSeason(['rename_team'])),
      getRoster: vi.fn(async () => ({ ...bobRoster, players: [] }))
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Robots' })).toBeInTheDocument();
    expect(screen.getByText('Mei Park · The Oracle')).toBeInTheDocument();
    expect(await screen.findByText('No players yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Propose trade' })).not.toBeInTheDocument();
  });

  it('says when the team is not in the league', async () => {
    open('/leagues/L1/team/teams/nobody');
    expect(await screen.findByText('Team not found')).toBeInTheDocument();
  });
});

describe('League pages', () => {
  const side = (teamId: string, teamName: string) => ({
    teamId,
    teamName,
    ownerName: null,
    manager: null,
    score: 50,
    record: '1-1'
  });
  const matchups: DashboardMatchup[] = [
    {
      id: 'm1',
      kind: 'regular',
      status: 'in_progress',
      home: side('team-1', "Alice's Team"),
      away: side('team-3', 'Robots')
    },
    {
      id: 'm2',
      kind: 'regular',
      status: 'final',
      home: side('team-2', "Bob's Team"),
      away: side('team-4', 'Team 4')
    }
  ];

  it('shows every matchup on the Scoreboard', async () => {
    open('/leagues/L1/league/scoreboard', {
      getLeagueDashboard: vi.fn(async () =>
        dashboard({ phase: 'regular_season', week: 3, draft: null, matchups, yourTeamId: 'team-1' })
      )
    });
    const region = await screen.findByRole('region', { name: 'Matchups' });
    expect(within(region).getAllByRole('link')).toHaveLength(2);
    // Bob's picked avatar shows beside his team (#178).
    expect(within(region).getByRole('img', { name: "Bob's Team avatar" })).toBeInTheDocument();
  });

  it('has no Scoreboard before the draft, and lists Draft results only after it', async () => {
    open('/leagues/L1/league/scoreboard', { getLeagueState: vi.fn(async () => state({ teams: TEAMS })) });
    expect(await screen.findByText('No matchups yet')).toBeInTheDocument();
    const pages = screen.getByRole('navigation', { name: 'League pages' });
    expect(within(pages).queryByRole('link', { name: 'Draft results' })).not.toBeInTheDocument();
  });

  it('shows the move board and the full log on Transactions', async () => {
    open('/leagues/L1/league/transactions');
    expect(await screen.findByRole('region', { name: 'Move board' })).toBeInTheDocument();
    const log = screen.getByRole('region', { name: 'Transactions' });
    expect(await within(log).findByText(/Zach Charbonnet/)).toBeInTheDocument();
    const pages = screen.getByRole('navigation', { name: 'League pages' });
    expect(within(pages).getByRole('link', { name: 'Draft results' })).toHaveAttribute(
      'href',
      '/leagues/L1/league/draft'
    );
  });

  it('reports a dashboard that fails to load', async () => {
    open('/leagues/L1/league/transactions', {
      getLeagueDashboard: vi.fn(async () => {
        throw new Error('down');
      })
    });
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
  });
});

describe('more of the shell', () => {
  it('reads older moves for one team a page at a time, and shows a bye and a free agent', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const json = (data: unknown) =>
      new Response(JSON.stringify({ data, league: null, warnings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (!url.pathname.endsWith('/transactions')) return json({});
        calls++;
        expect(url.searchParams.get('limit')).toBe('50');
        const add = (id: string, name: string) => ({
          id,
          at: '2026-09-20T12:00:00.000Z',
          week: 3,
          type: 'add',
          teamId: 'team-2',
          teamName: "Bob's Team",
          added: { id, name, team: 'NYJ', position: 'RB' },
          dropped: null,
          cost: null
        });
        return url.searchParams.get('cursor') === null
          ? json({ transactions: [add('m1', 'First Pickup')], nextCursor: 'older' })
          : json({ transactions: [add('m2', 'Older Pickup')], nextCursor: null });
      })
    );
    open('/leagues/L1/team/teams/team-2', {
      getRoster: vi.fn(async () => ({
        ...bobRoster,
        projectedPoints: undefined,
        players: [
          entry('bye', 'WR', { opponent: null, onBye: true }),
          entry('road', 'RB', { opponent: { team: 'BUF', home: false } }),
          entry('fa', 'BN', {
            opponent: undefined,
            player: { id: 'fa', name: 'Free Guy', team: null, position: 'K' }
          })
        ]
      }))
    });
    const lineup = await screen.findByRole('table', { name: "Bob's Team lineup" });
    expect(within(lineup).getAllByText('Bye').length).toBeGreaterThan(0);
    expect(within(lineup).getByText('@ BUF')).toBeInTheDocument();
    expect(within(lineup).getByText('K · FA')).toBeInTheDocument();
    expect(screen.queryByText(/^Projected/)).not.toBeInTheDocument();
    const moves = screen.getByRole('region', { name: 'Recent moves' });
    await user.click(await within(moves).findByRole('button', { name: 'Show older moves' }));
    expect(await within(moves).findByText(/Older Pickup/)).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('shows more of the move board on Transactions', async () => {
    const user = userEvent.setup();
    const move = (i: number) => ({
      id: `mv${i}`,
      type: 'add' as const,
      at: '2026-09-20T12:00:00.000Z',
      week: 3,
      teams: [
        {
          teamId: 'team-1',
          teamName: "Alice's Team",
          ownerName: 'Alice',
          manager: null,
          added: [{ id: `p${i}`, name: `Pickup ${i}`, team: 'NYJ', position: 'RB' }],
          dropped: [],
          cost: null
        }
      ]
    });
    const getLeagueDashboard = vi.fn(async (_id: string, query: { moves?: number } = {}) =>
      dashboard({
        phase: 'regular_season',
        draft: null,
        moves: Array.from({ length: query.moves ?? 8 }, (_, i) => move(i)),
        hasMoreMoves: true
      })
    );
    open('/leagues/L1/league/transactions', { getLeagueDashboard });
    const board = await screen.findByRole('region', { name: 'Move board' });
    await user.click(within(board).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(getLeagueDashboard).toHaveBeenLastCalledWith('L1', { moves: 18 }));
  });

  it('keeps the profile form honest: no blank names, and a picked avatar before any change', async () => {
    const user = userEvent.setup();
    open('/leagues/L1/team/profile', {
      getLeagueState: vi.fn(async () => ({
        ...inSeason(),
        teams: [{ ...TEAMS[0]!, avatarSeed: 'picked' }, ...TEAMS.slice(1)]
      }))
    });
    expect(await screen.findByRole('img', { name: "Alice's Team avatar" })).toBeInTheDocument();
    const name = screen.getByLabelText('Team name');
    await user.clear(name);
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    expect(screen.getByRole('img', { name: "Alice's Team avatar" })).toBeInTheDocument();
  });

  it('shows a loading league on Other teams and on a team page', async () => {
    const pending = () => new Promise<never>(() => undefined);
    open('/leagues/L1/team/teams', { getLeagueState: vi.fn(pending) });
    expect(await screen.findByText("Loading the league's teams…")).toBeInTheDocument();
  });
});
