import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type { EventConnect, LeagueEvent } from '../../realtime/leagueEvents';
import type { MatchupData, Roster, RosterEntry, SlotCount, StandingsData } from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { MATCHUP_POLL_MS, MatchupPage } from './MatchupPage';
import { planMove, slotOptions, statusLabel } from './slots';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

const SLOTS: SlotCount[] = [
  { slot: 'QB', count: 1 },
  { slot: 'WR', count: 1 },
  { slot: 'W/R/T', count: 1 },
  { slot: 'BN', count: 5 },
  { slot: 'IR', count: 1 }
];

function entry(id: string, position: string, slot: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    player: { id, name: id.toUpperCase(), team: 'KC', position },
    slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: 10,
    onBye: false,
    kickoff: '2026-09-13T17:00:00.000Z',
    locked: false,
    projectedPoints: 10,
    points: null,
    ...extra
  };
}

function roster(players: RosterEntry[], extra: Partial<Roster> = {}): Roster {
  return {
    teamId: 'team-1',
    teamName: "Alice's Team",
    week: 1,
    lineupSaved: true,
    carriedFromWeek: null,
    slots: SLOTS,
    players,
    ...extra
  };
}

const inSeason = () => state({ phase: 'regular_season', week: 1 });
const noMoves = {
  trades: 0,
  tradesWon: 0,
  tradesLost: 0,
  tradeValue: 0,
  waiverClaims: 0,
  waiverHits: 0,
  waiverHitRate: null,
  waiverNetPoints: 0
};
const refused = (status: number, code: string, message: string, fix: string) =>
  new ApiError(status, { code, message, fix });

function open(path: string, overrides: Partial<LeagueApi>) {
  const api = fakeApi({ getLeagueState: vi.fn(async () => inSeason()), ...overrides });
  renderApp(path, undefined, api);
  return api;
}

beforeEach(() => signInAs(ALICE));
afterEach(() => vi.useRealTimers());

describe('slot helpers', () => {
  it('offers eligible starting slots, the bench, and IR only for IR-eligible players', () => {
    expect(slotOptions(entry('wr', 'WR', 'BN'), SLOTS)).toEqual(['WR', 'W/R/T']);
    expect(slotOptions(entry('qb', 'QB', 'QB', { status: 'out' }), SLOTS)).toEqual(['BN', 'IR']);
    expect(slotOptions(entry('k', 'K', 'BN'), SLOTS)).toEqual([]);
    expect(slotOptions(entry('lb', 'LB', 'BN'), [...SLOTS, { slot: 'DL', count: 1 }])).toEqual([]);
  });

  it('swaps with the first unlocked occupant of a full slot', () => {
    const players = [entry('a', 'WR', 'WR'), entry('b', 'WR', 'BN')];
    expect(planMove(players, SLOTS, 'b', 'WR')).toEqual([
      { playerId: 'b', slot: 'WR' },
      { playerId: 'a', slot: 'BN' }
    ]);
    expect(planMove(players, SLOTS, 'b', 'W/R/T')).toEqual([{ playerId: 'b', slot: 'W/R/T' }]);
    expect(planMove(players, SLOTS, 'a', 'BN')).toEqual([{ playerId: 'a', slot: 'BN' }]);
    const locked = [entry('a', 'WR', 'WR', { locked: true }), entry('b', 'WR', 'BN')];
    expect(planMove(locked, SLOTS, 'b', 'WR')).toBeNull();
    expect(planMove(players, SLOTS, 'nobody', 'WR')).toBeNull();
    expect(planMove(players, SLOTS, 'b', 'TE')).toBeNull();
  });

  it('labels byes and injuries', () => {
    expect(statusLabel(entry('a', 'WR', 'BN'))).toBeNull();
    expect(statusLabel(entry('a', 'WR', 'BN', { onBye: true }))).toBe('Bye');
    expect(statusLabel(entry('a', 'WR', 'BN', { status: 'out', injuryStatus: 'Out' }))).toBe('Out');
    expect(statusLabel(entry('a', 'WR', 'BN', { status: 'suspended' }))).toBe('SUSPENDED');
  });
});

describe('RosterPage', () => {
  it('shows the lineup with lock and status badges and saves a swap', async () => {
    let current = roster([
      entry('qb1', 'QB', 'QB', { locked: true }),
      entry('wr1', 'WR', 'WR'),
      entry('wr2', 'WR', 'BN', { onBye: true, byeWeek: 1 }),
      entry('rb1', 'RB', 'W/R/T', {
        status: 'out',
        injuryStatus: 'Out',
        byeWeek: null,
        player: { id: 'rb1', name: 'RB1', team: null, position: 'RB' }
      })
    ]);
    const setLineup = vi.fn(async () => {
      current = roster(
        current.players.map((p) =>
          p.player.id === 'wr2' ? { ...p, slot: 'WR' } : p.player.id === 'wr1' ? { ...p, slot: 'BN' } : p
        )
      );
      return { roster: current, warnings: [{ code: 'STARTER_ON_BYE', message: 'WR2 is on bye.' }] };
    });
    const api = open('/leagues/L1/roster', { getRoster: vi.fn(async () => current), setLineup });
    const user = userEvent.setup();

    const qb = await screen.findByTestId('roster-row-qb1');
    expect(within(qb).getByText('Locked')).toBeInTheDocument();
    expect(within(qb).getByRole('combobox')).toBeDisabled();
    expect(within(screen.getByTestId('roster-row-wr2')).getByText('Bye')).toBeInTheDocument();
    const rb = screen.getByTestId('roster-row-rb1');
    expect(within(rb).getByText('Out')).toBeInTheDocument();
    expect(within(rb).getByText(/RB · FA$/)).toBeInTheDocument();
    // On a phone each row is a card: the numbers carry their column names.
    expect(
      within(rb)
        .getAllByRole('cell')
        .map((cell) => cell.dataset.label ?? null)
    ).toEqual([null, null, null, 'Proj', 'Pts', null]);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Move WR2' }), 'WR');
    expect(await screen.findByText('WR2 is on bye.')).toBeInTheDocument();
    expect(setLineup).toHaveBeenCalledWith('L1', 'team-1', 1, [
      { playerId: 'wr2', slot: 'WR' },
      { playerId: 'wr1', slot: 'BN' }
    ]);
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: 'Starters' })).getByText('WR2')).toBeInTheDocument()
    );
    expect(api.getRoster).toHaveBeenCalledTimes(2);
  });

  it('explains a refused move with its fix, and a slot full of locked players', async () => {
    const current = roster([
      entry('wr1', 'WR', 'WR', { locked: true }),
      entry('wr2', 'WR', 'BN'),
      entry('wr3', 'WR', 'BN'),
      entry('rb1', 'RB', 'W/R/T')
    ]);
    open('/leagues/L1/roster', {
      getRoster: vi.fn(async () => current),
      setLineup: vi.fn(async () => {
        throw refused(409, 'PLAYER_LOCKED', 'RB1 is locked.', 'Keep him in W/R/T.');
      })
    });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Move WR2' }), 'WR');
    expect(await screen.findByText('Every WR slot holds a locked player.')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Move WR3' }), 'W/R/T');
    expect(await screen.findByText('RB1 is locked.')).toBeInTheDocument();
    expect(screen.getByText('Keep him in W/R/T.')).toBeInTheDocument();
  });

  it('shows an empty roster carried over from an earlier week', async () => {
    open('/leagues/L1/roster', { getRoster: vi.fn(async () => roster([], { carriedFromWeek: 0 })) });
    expect(await screen.findByText('No players yet')).toBeInTheDocument();
    expect(screen.getByText(/carried over from week 0/)).toBeInTheDocument();
  });

  it('says so when you have no team', async () => {
    open('/leagues/L1/roster', { getLeagueState: vi.fn(async () => state({ yourTeam: null })) });
    expect(await screen.findByText('No team')).toBeInTheDocument();
  });

  it('shows load errors for the league and the roster', async () => {
    open('/leagues/L1/roster', {
      getLeagueState: vi.fn(async () => {
        throw refused(403, 'FORBIDDEN', 'Not a member.', 'Join first.');
      })
    });
    expect(await screen.findByText('Not a member.')).toBeInTheDocument();
  });

  it('shows a roster load error', async () => {
    open('/leagues/L1/roster', {
      getRoster: vi.fn(async () => {
        throw new Error('Boom.');
      })
    });
    expect(await screen.findByText('Boom.')).toBeInTheDocument();
  });
});

function matchupData(status: 'scheduled' | 'in_progress' | 'final', homeScore: number | null): MatchupData {
  return {
    week: 1,
    teamId: 'team-1',
    matchup: {
      id: 'W01-1',
      status,
      home: { teamId: 'team-1', teamName: "Alice's Team", score: homeScore },
      away: {
        teamId: 'team-2',
        teamName: 'Robots',
        score: 12.5,
        manager: { name: 'Mei Park', avatarSeed: 'mei', personality: 'The Oracle' }
      }
    },
    lineups: {
      home: {
        teamId: 'team-1',
        points: homeScore ?? 0,
        players: [entry('qb1', 'QB', 'QB', { points: homeScore }), entry('wr9', 'WR', 'BN')]
      },
      away: {
        teamId: 'team-2',
        points: 12.5,
        players: [
          entry('qb2', 'QB', 'QB', {
            points: 12.5,
            projectedPoints: null,
            player: { id: 'qb2', name: 'QB2', team: null, position: 'QB' }
          })
        ]
      }
    }
  };
}

describe('team achievements on the roster', () => {
  const achievement = (id: string, teamId: string, name: string, week: number | null) => ({
    id,
    achievementId: 'blowout-win',
    name,
    teamId,
    teamName: teamId,
    week,
    reason: `${name} reason`
  });

  it("shows the team's own badges in the roster header", async () => {
    open('/leagues/L1/roster', {
      getRoster: vi.fn(async () => roster([entry('qb1', 'QB', 'QB')])),
      getLeagueHistory: vi.fn(async () => ({
        ...(await fakeApi().getLeagueHistory('L1')),
        achievements: [
          achievement('a1', 'team-1', 'Blowout', 3),
          achievement('a2', 'team-1', 'League Champion', null),
          achievement('a3', 'team-2', 'Record Setter', null)
        ]
      }))
    });
    const badges = await screen.findByRole('list', { name: 'Team achievements' });
    expect(badges).toHaveTextContent('Blowout · week 3');
    expect(badges).toHaveTextContent('League Champion');
    expect(badges).not.toHaveTextContent('Record Setter');
    expect(within(badges).getAllByRole('listitem')[0]).toHaveAttribute('title', 'Blowout reason');
  });

  it('shows nothing before the team earns one', async () => {
    const api = open('/leagues/L1/roster', { getRoster: vi.fn(async () => roster([])) });
    await screen.findByText('No players yet');
    await waitFor(() => expect(api.getLeagueHistory).toHaveBeenCalled());
    expect(screen.queryByTestId('team-achievements')).not.toBeInTheDocument();
  });
});

describe('MatchupPage', () => {
  it('shows both lineups and polls for live scores', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let score = 10;
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchupData('in_progress', score)) });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('10.00');
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Robots' })).getByText('QB2')).toBeInTheDocument();
    expect(screen.queryByText('WR9')).not.toBeInTheDocument();
    score = 24.5;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MATCHUP_POLL_MS);
    });
    await waitFor(() => expect(screen.getByTestId('score-team-1')).toHaveTextContent('24.50'));
  });

  it('refreshes scores on live Scores Updated events from the global topic', async () => {
    let score = 10;
    let onEvent: (event: LeagueEvent) => void = () => undefined;
    const connect: EventConnect = async (target, handlers) => {
      expect(target.topics).toEqual(['fantasy.league.L1', 'fantasy.global']);
      onEvent = handlers.onEvent;
      return () => undefined;
    };
    const api = fakeApi({
      getMatchup: vi.fn(async () => matchupData('in_progress', score)),
      getRealtime: vi.fn(async () => ({
        enabled: true,
        token: 't',
        endpoint: null,
        cacheName: 'c',
        topics: { league: 'fantasy.league.L1', global: 'fantasy.global' },
        expiresAt: null,
        pollIntervalSeconds: 30
      }))
    });
    render(
      <LeagueApiContext.Provider value={api}>
        <MemoryRouter initialEntries={['/leagues/L1/matchup']}>
          <Routes>
            <Route path="/leagues/:leagueId/matchup" element={<MatchupPage connect={connect} />} />
          </Routes>
        </MemoryRouter>
      </LeagueApiContext.Provider>
    );
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('10.00');
    await waitFor(() => expect(api.getRealtime).toHaveBeenCalledWith('L1'));
    score = 31;
    act(() => onEvent({ detailType: 'Scores Updated', leagueId: null }));
    await waitFor(() => expect(screen.getByTestId('score-team-1')).toHaveTextContent('31.00'));
  });

  it('shows a final matchup', async () => {
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchupData('final', null)) });
    expect(await screen.findByText('Final')).toBeInTheDocument();
    expect(screen.getByTestId('score-team-1')).toHaveTextContent('0.00');
  });

  it('shows when there is no matchup', async () => {
    open('/leagues/L1/matchup', {
      getMatchup: vi.fn(async () => ({ week: 3, teamId: 'team-1', matchup: null, lineups: null }))
    });
    expect(await screen.findByText('No matchup in week 3')).toBeInTheDocument();
  });

  it('shows errors', async () => {
    open('/leagues/L1/matchup', {
      getMatchup: vi.fn(async () => {
        throw refused(403, 'FORBIDDEN', 'Not a member.', 'Join first.');
      })
    });
    expect(await screen.findByText('Join first.')).toBeInTheDocument();
  });
});

describe('StandingsPage', () => {
  const standings: StandingsData = {
    throughWeek: 2,
    standings: [
      {
        rank: 1,
        teamId: 'team-1',
        teamName: "Alice's Team",
        record: '2-0',
        pointsFor: 250.5,
        pointsAgainst: 200,
        streak: 'W2'
      },
      {
        rank: 2,
        teamId: 'team-2',
        teamName: 'Robots',
        manager: { name: 'Mei Park', avatarSeed: 'mei', personality: 'The Oracle' },
        record: '0-2',
        pointsFor: 200,
        pointsAgainst: 250.5,
        streak: null
      }
    ]
  };

  it('lists teams by rank', async () => {
    open('/leagues/L1/standings', { getStandings: vi.fn(async () => standings) });
    const table = await screen.findByRole('table', { name: 'Standings' });
    expect(within(table).getByText('Through week 2')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent("1Alice's Team2-0250.50200.00W2");
    // On a phone each row is a card: the numbers carry their column names, the header row hides.
    const first = within(table).getAllByRole('row')[1]!;
    expect(
      within(first)
        .getAllByRole('cell')
        .map((cell) => cell.dataset.label ?? null)
    ).toEqual([null, null, null, 'PF', 'PA', 'Streak']);
    expect(table.querySelector('thead')).toHaveClass('max-sm:sr-only');
  });

  it("shows an AI team's manager name and avatar (#159)", async () => {
    open('/leagues/L1/standings', { getStandings: vi.fn(async () => standings) });
    const table = await screen.findByRole('table', { name: 'Standings' });
    const robots = within(table).getAllByRole('row')[2]!;
    expect(within(robots).getByTestId('manager-tag')).toHaveTextContent('Mei Park');
    expect(within(robots).getByRole('img', { name: 'Mei Park avatar' })).toBeInTheDocument();
    expect(within(within(table).getAllByRole('row')[1]!).queryByTestId('manager-tag')).toBeNull();
  });

  it('says when no week is final yet', async () => {
    open('/leagues/L1/standings', {
      getStandings: vi.fn(async () => ({ throughWeek: null, standings: standings.standings }))
    });
    expect(await screen.findByText('No games final yet')).toBeInTheDocument();
  });

  it('shows an empty state before the season', async () => {
    open('/leagues/L1/standings', {});
    expect(await screen.findByText('No standings yet')).toBeInTheDocument();
  });

  it('ranks the models playing the league next to the standings', async () => {
    const record = { wins: 2, losses: 0, ties: 0, winRate: 1, pointsFor: 250.5, costUsd: 0.4, ...noMoves };
    open('/leagues/L1/standings', {
      getStandings: vi.fn(async () => standings),
      getModelLeaderboard: vi.fn(async () => ({
        throughWeek: 2,
        teams: [],
        models: [
          {
            ...record,
            modelKey: 'claude-opus-5',
            modelName: 'Claude Opus 5',
            provider: 'anthropic',
            teams: 1,
            bestRank: 1,
            pointsForPerTeam: 250.5,
            costPerWinUsd: 0.2,
            trades: 2,
            tradesWon: 2,
            tradesLost: 0,
            tradeValue: 31.25,
            waiverClaims: 3,
            waiverHits: 2,
            waiverHitRate: 0.667
          },
          {
            ...record,
            wins: 0,
            losses: 2,
            winRate: 0,
            costUsd: 0,
            modelKey: 'human',
            modelName: 'Human',
            provider: null,
            teams: 1,
            bestRank: 2,
            pointsForPerTeam: 200,
            costPerWinUsd: null,
            trades: 2,
            tradesWon: 0,
            tradesLost: 2,
            tradeValue: -31.25
          }
        ]
      }))
    });
    const table = await screen.findByRole('table', { name: 'Model power rankings' });
    expect(screen.getByRole('heading', { name: 'Which model wins the league?' })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('1Claude Opus 512-0100%250.5+31.3 (2-0)2/3 (67%)$0.40$0.20');
    expect(rows[2]).toHaveTextContent('2Human10-20%200.0-31.3 (0-2)–––');
  });

  it('shows ties, tiny costs, and a league with no final week in the model rankings', async () => {
    const model = {
      wins: 1,
      losses: 0,
      ties: 1,
      winRate: 0.75,
      pointsFor: 200,
      costUsd: 0.004,
      modelKey: 'nova-micro',
      modelName: 'Amazon Nova Micro',
      provider: 'amazon',
      teams: 1,
      bestRank: 1,
      pointsForPerTeam: 200,
      costPerWinUsd: 0.004,
      ...noMoves
    };
    open('/leagues/L1/standings', {
      getStandings: vi.fn(async () => standings),
      getModelLeaderboard: vi.fn(async () => ({
        throughWeek: null,
        teams: [],
        models: [model, { ...model, modelKey: 'nova-lite', winRate: null, costUsd: 0, costPerWinUsd: null }]
      }))
    });
    const table = await screen.findByRole('table', { name: 'Model power rankings' });
    expect(within(table).getByText(/No games final yet/)).toBeInTheDocument();
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
      '1Amazon Nova Micro11-0-175%200.0––<$0.01<$0.01'
    );
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('1-0-1–200.0––$0.00–');
  });

  it('hides the model rankings in a league without agents or when they fail to load', async () => {
    open('/leagues/L1/standings', {
      getStandings: vi.fn(async () => standings),
      getModelLeaderboard: vi.fn(async () => {
        throw refused(403, 'FORBIDDEN', 'No.', 'Join.');
      })
    });
    await screen.findByRole('table', { name: 'Standings' });
    await waitFor(() => expect(screen.queryByText('Loading model rankings…')).not.toBeInTheDocument());
    expect(screen.queryByTestId('model-leaderboard')).not.toBeInTheDocument();
  });

  it('shows errors', async () => {
    open('/leagues/L1/standings', {
      getStandings: vi.fn(async () => {
        throw refused(404, 'LEAGUE_NOT_FOUND', 'No league.', 'Check the id.');
      })
    });
    expect(await screen.findByText('No league.')).toBeInTheDocument();
  });
});
