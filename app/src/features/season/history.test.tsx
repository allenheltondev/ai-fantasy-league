import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { LeagueApi } from '../../api/league';
import type { LeagueHistoryData, PlayoffBracketData } from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
import { renderApp, signInAs } from '../../test/render';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

function open(path: string, overrides: Partial<LeagueApi>) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () => state({ phase: 'playoffs', week: 16 })),
    ...overrides
  });
  renderApp(path, undefined, api);
  return api;
}

const refused = () =>
  new ApiError(403, { code: 'NOT_A_MEMBER', message: 'Not a member.', fix: 'Join first.' });

beforeEach(() => signInAs(ALICE));

const side = (teamId: string | null, seed: number | null, score: number | null, from = `Seed ${seed}`) => ({
  teamId,
  teamName: teamId === null ? null : `Team ${teamId}`,
  seed,
  score,
  from
});

const bracket: PlayoffBracketData = {
  status: 'complete',
  teams: 4,
  byes: 0,
  weeks: [16, 17],
  reseed: false,
  consolation: true,
  seeds: [
    { seed: 1, teamId: 't1', teamName: 'Team t1' },
    { seed: 2, teamId: 't2', teamName: 'Team t2' }
  ],
  games: [
    {
      id: 'championship-r1-g1',
      bracket: 'championship',
      round: 1,
      week: 16,
      home: side('t1', 1, 100),
      away: side('t4', 4, 90),
      winnerTeamId: 't1',
      decidedBySeed: false
    },
    {
      id: 'championship-r2-g1',
      bracket: 'championship',
      round: 2,
      week: 17,
      home: side('t1', 1, 80),
      away: side('t2', 2, 80),
      winnerTeamId: 't1',
      decidedBySeed: true
    },
    {
      id: 'consolation-r2-g1',
      bracket: 'consolation',
      round: 2,
      week: 17,
      home: side(null, null, null, 'Winner of consolation-r1-g1'),
      away: side('t6', 6, null),
      winnerTeamId: null,
      decidedBySeed: false
    }
  ],
  championTeamId: 't1',
  consolationChampionTeamId: null
};

describe('Playoffs tab', () => {
  it('shows the champion, a tie decided by seed, and the consolation bracket', async () => {
    const user = userEvent.setup();
    open('/leagues/L1/standings', { getPlayoffBracket: vi.fn(async () => bracket) });
    await user.click(await screen.findByRole('tab', { name: 'Playoffs' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Champion: Team t1');
    expect(screen.getByText(/Playoffs complete\. 4 teams, 0 byes, fixed bracket\./)).toBeInTheDocument();
    expect(screen.getByText('Tie: the better seed advances.')).toBeInTheDocument();
    const consolation = screen.getByRole('region', { name: 'Consolation bracket' });
    expect(within(consolation).getByText('Winner of consolation-r1-g1')).toBeInTheDocument();
  });

  it('explains an empty bracket', async () => {
    open('/leagues/L1/standings?view=playoffs', {});
    expect(await screen.findByText('No bracket yet')).toBeInTheDocument();
    expect(screen.getByText('The bracket is seeded once the regular season ends.')).toBeInTheDocument();
  });

  it('shows a projected, reseeded bracket with one bye', async () => {
    open('/leagues/L1/standings?view=playoffs', {
      getPlayoffBracket: vi.fn(async () => ({
        ...bracket,
        status: 'projected' as const,
        byes: 1,
        reseed: true,
        consolation: false,
        championTeamId: null,
        games: bracket.games.slice(0, 1)
      }))
    });
    expect(await screen.findByText(/Projected: .* 1 bye, reseeded each round\./)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Consolation bracket' })).toBeNull();
  });

  it('shows errors', async () => {
    open('/leagues/L1/standings?view=playoffs', {
      getPlayoffBracket: vi.fn(async () => Promise.reject(refused()))
    });
    expect(await screen.findByText('Not a member.')).toBeInTheDocument();
  });
});

const noRecords = { highestScore: null, lowestScore: null, biggestBlowout: null, closestGame: null };

const history: LeagueHistoryData = {
  seasons: [
    {
      season: 2025,
      championTeamId: 't1',
      championName: 'Team t1',
      runnerUpTeamId: 't2',
      finalStandings: [],
      records: noRecords,
      completedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      season: 2024,
      championTeamId: null,
      championName: null,
      runnerUpTeamId: null,
      finalStandings: [],
      records: noRecords,
      completedAt: '2025-01-01T00:00:00.000Z'
    }
  ],
  current: {
    season: 2026,
    records: {
      highestScore: { teamId: 't1', teamName: 'Team t1', week: 3, points: 160.5 },
      lowestScore: { teamId: 't2', teamName: 'Team t2', week: 2, points: 50 },
      biggestBlowout: {
        week: 3,
        winnerTeamId: 't1',
        winnerName: 'Team t1',
        loserTeamId: 't2',
        loserName: 'Team t2',
        winnerScore: 160.5,
        loserScore: 60,
        margin: 100.5
      },
      closestGame: {
        week: 4,
        winnerTeamId: 't2',
        winnerName: 'Team t2',
        loserTeamId: 't1',
        loserName: 'Team t1',
        winnerScore: 90,
        loserScore: 89.5,
        margin: 0.5
      }
    },
    headToHead: [
      {
        teamId: 't1',
        teamName: 'Team t1',
        opponentId: 't2',
        opponentName: 'Team t2',
        wins: 2,
        losses: 1,
        ties: 1
      },
      {
        teamId: 't1',
        teamName: 'Team t1',
        opponentId: 't3',
        opponentName: 'Team t3',
        wins: 1,
        losses: 0,
        ties: 0
      }
    ]
  },
  achievements: [
    {
      id: 'a1',
      achievementId: 'blowout-win',
      name: 'Blowout',
      teamId: 't1',
      teamName: 'Team t1',
      week: 3,
      reason: 'Won by 100.5 in week 3'
    }
  ],
  trades: [
    {
      id: 'x1',
      at: '2026-10-01T00:00:00.000Z',
      week: 5,
      teamName: 'Team t1',
      added: { id: 'p1', name: 'Player One', team: 'KC', position: 'WR' },
      dropped: null
    },
    {
      id: 'x2',
      at: '2026-10-01T00:00:00.000Z',
      week: 5,
      teamName: 'Team t2',
      added: null,
      dropped: { id: 'p1', name: 'Player One', team: 'KC', position: 'WR' }
    }
  ],
  tradeRecords: {
    best: [
      {
        tradeId: 'tr1',
        at: '2026-10-01T00:00:00.000Z',
        week: 5,
        teamId: 't1',
        teamName: 'Team t1',
        partnerTeamId: 't2',
        partnerName: 'Team t2',
        received: [{ id: 'p1', name: 'Player One', team: 'KC', position: 'WR' }],
        sent: [],
        valueDelta: 42.25
      }
    ],
    worst: []
  }
};

describe('History tab', () => {
  it('shows champions, records, head-to-head, achievements, and trades', async () => {
    const user = userEvent.setup();
    open('/leagues/L1/standings', { getLeagueHistory: vi.fn(async () => history) });
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('No champion')).toBeInTheDocument();
    const records = screen.getByLabelText('2026 records', { selector: 'dl' });
    expect(records).toHaveTextContent('Team t1, 160.50 (week 3)');
    expect(records).toHaveTextContent('Team t1 over Team t2 by 100.50 (week 3)');
    expect(records).toHaveTextContent('Team t2 over Team t1 by 0.50 (week 4)');
    expect(screen.getByRole('table', { name: 'Head to head' })).toHaveTextContent('Team t1 vs Team t22-1-1');
    expect(screen.getByText(/Blowout \(Won by 100.5 in week 3\)/)).toBeInTheDocument();
    expect(screen.getByText('Week 5: Team t1 gets Player One')).toBeInTheDocument();
    expect(screen.getByText('Week 5: Team t2 sends Player One')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Best trades' })).toHaveTextContent(
      'Team t1 +42.3 (week 5): got Player One for nothing from Team t2'
    );
    expect(screen.getByText('None yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Standings' }));
    expect(await screen.findByText('No standings yet')).toBeInTheDocument();
  });

  it('shows an empty history', async () => {
    open('/leagues/L1/standings?view=history', {});
    expect(await screen.findByText('No completed seasons yet.')).toBeInTheDocument();
    expect(screen.getByText('No achievements earned yet.')).toBeInTheDocument();
    expect(screen.getByText('No trades yet.')).toBeInTheDocument();
    expect(screen.getByText("No trade has changed a team's value yet.")).toBeInTheDocument();
    expect(screen.getByText('No games final yet.')).toBeInTheDocument();
  });

  it('shows errors', async () => {
    open('/leagues/L1/standings?view=history', {
      getLeagueHistory: vi.fn(async () => Promise.reject(refused()))
    });
    expect(await screen.findByText('Not a member.')).toBeInTheDocument();
  });
});
