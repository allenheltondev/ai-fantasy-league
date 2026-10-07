import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { LeagueApiContext, type LeagueApi } from '../../api/league';
import type { EventConnect, LeagueEvent } from '../../realtime/leagueEvents';
import type {
  MatchupData,
  MatchupOutlook,
  Roster,
  RosterEntry,
  SlotCount,
  StandingsData
} from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';
import { MATCHUP_POLL_MS, MatchupPage } from './MatchupPage';
import { statusLabel } from './slots';

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
  it('labels byes and injuries', () => {
    expect(statusLabel(entry('a', 'WR', 'BN'))).toBeNull();
    expect(statusLabel(entry('a', 'WR', 'BN', { onBye: true }))).toBe('Bye');
    expect(statusLabel(entry('a', 'WR', 'BN', { status: 'out', injuryStatus: 'Out' }))).toBe('Out');
    expect(statusLabel(entry('a', 'WR', 'BN', { status: 'suspended' }))).toBe('SUSPENDED');
  });
});

describe('RosterPage', () => {
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

describe('My Team › Achievements', () => {
  const achievement = (id: string, teamId: string, name: string, week: number | null) => ({
    id,
    achievementId: 'blowout-win',
    name,
    teamId,
    teamName: teamId,
    week,
    reason: `${name} reason`
  });

  it("shows the team's own badges on My Team", async () => {
    open('/leagues/L1/team/lineup', {
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
    const api = open('/leagues/L1/team/lineup', {});
    await waitFor(() => expect(api.getLeagueHistory).toHaveBeenCalled());
    expect(await screen.findByTestId('team-header')).toBeInTheDocument();
    expect(screen.queryByTestId('team-achievements')).not.toBeInTheDocument();
  });
});

describe('MatchupPage', () => {
  it('shows both lineups and polls for live scores', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let score = 10;
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchupData('in_progress', score)) });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('10.00');
    // The week is under way, but no one in this matchup has kicked off: not live yet.
    const bar = screen.getByTestId('score-bar');
    expect(within(bar).queryByText('Live')).not.toBeInTheDocument();
    expect(within(bar).queryByText('In progress')).not.toBeInTheDocument();
    expect(within(bar).queryByText('Upcoming')).not.toBeInTheDocument();
    // Head to head by slot: their QB faces yours.
    expect(within(screen.getByTestId('h2h-row-QB-0')).getAllByText('QB2').length).toBeGreaterThan(0);
    // The bench starts collapsed.
    expect(screen.getByTestId('h2h-bench')).not.toBeVisible();
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

  it('shows a final matchup, with no lineup to edit', async () => {
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchupData('final', null)) });
    expect(await screen.findByText('Final')).toBeInTheDocument();
    expect(screen.getByTestId('score-team-1')).toHaveTextContent('0.00');
    expect(screen.queryByRole('link', { name: 'Edit lineup' })).toBeNull();
  });

  it('puts your locks and Edit lineup on your side when you are the away team (#193)', async () => {
    const away = matchupData('in_progress', 10);
    away.teamId = 'team-2';
    away.lineups!.away.players = [entry('qb2', 'QB', 'QB', { locked: true, points: 12.5 })];
    away.lineups!.away.players.push(entry('wr2', 'WR', 'WR'));
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => away) });
    const qb2 = await screen.findByTestId('h2h-player-qb2');
    expect(within(qb2).getByRole('img', { name: 'Locked: game started' })).toBeInTheDocument();
    expect(within(screen.getByTestId('h2h-player-qb1')).queryByTestId('lock-mark')).toBeNull();
    expect(screen.getByRole('link', { name: 'Edit lineup' })).toHaveAttribute(
      'href',
      '/leagues/L1/team/lineup'
    );
  });

  it('shows no locks, lineup link, or outlook on a matchup you are not in', async () => {
    const theirs = matchupData('in_progress', 10);
    theirs.teamId = 'team-3';
    const api = open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => theirs) });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('10.00');
    expect(screen.queryByTestId('lock-mark')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit lineup' })).toBeNull();
    // The outlook panel loads on its own, after the board: wait for its read rather than race it.
    await waitFor(() => expect(api.getMatchupOutlook).toHaveBeenCalled());
  });

  const outlookTeam = (teamId: string, winProbability: number | null) => ({
    teamId,
    teamName: teamId,
    currentPoints: 10,
    projectedPoints: 100,
    remainingPoints: 90,
    playersYetToPlay: 1,
    playersInProgress: 0,
    winProbability
  });
  const outlookFor = (
    opponent: MatchupOutlook['opponent'],
    winProbability: number | null
  ): MatchupOutlook => ({
    week: 1,
    teamId: 'team-1',
    status: 'in_progress',
    you: outlookTeam('team-1', winProbability),
    opponent,
    insights: {
      startersOut: [],
      emptySlots: [{ slot: 'TE', missing: 1 }],
      benchUpgrades: [],
      lockedPlayers: [],
      currentProjectedPoints: 100,
      optimalProjectedPoints: 100
    }
  });

  it('feeds one outlook read to the header odds and the lineup advice', async () => {
    const getMatchupOutlook = vi.fn(async () => outlookFor(outlookTeam('team-2', 0.4), 0.6));
    open('/leagues/L1/matchup', {
      getMatchup: vi.fn(async () => matchupData('in_progress', 10)),
      getMatchupOutlook
    });
    expect(await screen.findByTestId('win-probability-home')).toHaveTextContent('60%');
    expect(screen.getByTestId('win-probability-away')).toHaveTextContent('40%');
    const advice = screen.getByRole('region', { name: 'Lineup advice' });
    expect(within(advice).getByText('Your TE slot is empty.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Outlook' })).toBeNull();
    expect(getMatchupOutlook).toHaveBeenCalledTimes(1);
  });

  it('leaves the header without odds when the outlook has none', async () => {
    const getMatchupOutlook = vi.fn();
    getMatchupOutlook.mockResolvedValueOnce(outlookFor(null, null));
    open('/leagues/L1/matchup', {
      getMatchup: vi.fn(async () => matchupData('in_progress', 10)),
      getMatchupOutlook
    });
    await screen.findByRole('region', { name: 'Lineup advice' });
    expect(screen.queryByTestId('win-probability')).toBeNull();
  });

  it('keeps the outlook off a ?team= matchup', async () => {
    const theirs = matchupData('in_progress', 10);
    const api = open('/leagues/L1/team/matchup?team=team-1', { getMatchup: vi.fn(async () => theirs) });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('10.00');
    expect(screen.queryByTestId('win-probability')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Lineup advice' })).toBeNull();
    expect(api.getMatchupOutlook).not.toHaveBeenCalled();
  });

  it("keeps another team's empty week free of your outlook", async () => {
    const api = open('/leagues/L1/team/matchup?team=team-3', {
      getMatchup: vi.fn(async () => ({ week: 3, teamId: 'team-3', matchup: null, lineups: null }))
    });
    expect(await screen.findByText('No matchup in week 3')).toBeInTheDocument();
    expect(api.getMatchupOutlook).not.toHaveBeenCalled();
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
    // What PF, PA, and the rest mean, for a newer manager.
    expect(within(table).getByRole('button', { name: 'How are standings decided?' })).toBeInTheDocument();
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
    // Observational (#211): standings are not a controlled comparison of models.
    expect(screen.getByTestId('model-leaderboard-note')).toHaveTextContent(/Observational, not a benchmark/);
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
