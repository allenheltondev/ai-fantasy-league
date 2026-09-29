import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeagueApi } from '../../api/league';
import type { MatchupData, PlayoffBracketData } from '../../api/types';
import { fakeApi, state } from '../../test/fakeApi';
import { mockReducedMotion } from '../../test/reducedMotion';
import { renderApp, signInAs } from '../../test/render';
import { leadingTeam, MATCHUP_POLL_MS } from './MatchupPage';
import { playoffMoment } from './PlayoffsPanel';
import { useYourTeamId } from '../../routes/leagueContext';

const ALICE = { sub: 'alice', email: 'alice@example.com', given_name: 'Alice' };

function open(path: string, overrides: Partial<LeagueApi>) {
  const api = fakeApi({
    getLeagueState: vi.fn(async () => state({ phase: 'regular_season', week: 3 })),
    ...overrides
  });
  const view = renderApp(path, undefined, api);
  return { api, view };
}

const player = (id: string, points: number | null) => ({
  player: { id, name: id.toUpperCase(), team: 'KC', position: 'WR' },
  slot: 'WR',
  status: 'active',
  injuryStatus: null,
  byeWeek: 10,
  onBye: false,
  kickoff: null,
  locked: true,
  projectedPoints: 10,
  points
});

function matchup(
  status: 'scheduled' | 'in_progress' | 'final',
  mine: number | null,
  theirs: number | null
): MatchupData {
  return {
    week: 3,
    teamId: 'team-1',
    matchup: {
      id: 'W03-1',
      status,
      home: { teamId: 'team-1', teamName: "Alice's Team", score: mine },
      away: { teamId: 'team-2', teamName: 'Robots', score: theirs }
    },
    lineups: {
      home: { teamId: 'team-1', points: mine ?? 0, players: [player('wr1', mine)] },
      away: { teamId: 'team-2', points: theirs ?? 0, players: [player('wr2', theirs)] }
    }
  };
}

let motion: ReturnType<typeof mockReducedMotion>;
beforeEach(() => {
  signInAs(ALICE);
  motion = mockReducedMotion(false);
});
afterEach(() => {
  motion.restore();
  vi.useRealTimers();
});

describe('live matchup motion', () => {
  it('counts the total to the new score, floats the change, and moves the lead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let data = matchup('in_progress', 10, 12);
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => data) });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('10.00');
    const robots = screen.getByRole('region', { name: 'Robots' });
    expect(robots).toHaveAttribute('data-leading', 'true');
    // The trailing total steps back (#193): muted, while the leader's stays full strength.
    expect(screen.getByTestId('score-team-1')).toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('score-team-2')).not.toHaveClass('text-muted-foreground');
    expect(screen.getByText('Live').querySelector('.motion-live-dot')).not.toBeNull();

    data = matchup('in_progress', 16, 12);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MATCHUP_POLL_MS);
    });
    const mine = screen.getByRole('region', { name: "Alice's Team" });
    await waitFor(() =>
      expect(within(screen.getByTestId('h2h-row-WR-0')).getByTestId('delta-floater')).toHaveTextContent(
        '+6.0'
      )
    );
    expect(screen.getByTestId('score-team-1')).toHaveAttribute('data-flash', 'up');
    await waitFor(() => expect(screen.getByTestId('score-team-1')).toHaveTextContent('16.00'));
    expect(mine).toHaveAttribute('data-leading', 'true');
    expect(robots).not.toHaveAttribute('data-leading');
  });

  it('knows who leads', () => {
    const m = (s: 'scheduled' | 'in_progress' | 'final', a: number | null, b: number | null) =>
      matchup(s, a, b).matchup!;
    expect(leadingTeam(m('scheduled', 0, 0))).toBeNull();
    expect(leadingTeam(m('in_progress', null, 3))).toBeNull();
    expect(leadingTeam(m('in_progress', 5, 5))).toBeNull();
    expect(leadingTeam(m('final', 5, 3))).toBe('team-1');
    expect(leadingTeam(m('final', 1, 3))).toBe('team-2');
  });

  it('shows a shimmer while the matchup loads', async () => {
    open('/leagues/L1/matchup', { getMatchup: vi.fn(() => new Promise<MatchupData>(() => undefined)) });
    expect(await screen.findByText('Loading your matchup…')).toBeInTheDocument();
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });
});

describe('win celebration', () => {
  it('bursts confetti the first time you see a won final, and not again', async () => {
    const getMatchup = vi.fn(async () => matchup('final', 101.5, 88));
    const first = open('/leagues/L1/matchup', { getMatchup });
    expect(await screen.findByText('You won week 3!')).toBeInTheDocument();
    expect(screen.getByTestId('confetti')).toHaveAttribute('data-size', 'burst');
    first.view.unmount();

    open('/leagues/L1/matchup', { getMatchup });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('101.50');
    expect(screen.queryByText('You won week 3!')).not.toBeInTheDocument();
    expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
  });

  it('does not celebrate a loss or a game still in progress', async () => {
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchup('final', 70, 88)) });
    expect(await screen.findByTestId('score-team-1')).toHaveTextContent('70.00');
    expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
  });

  it('skips the confetti under reduced motion but still says you won', async () => {
    motion.set(true);
    open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchup('final', 101.5, 88)) });
    expect(await screen.findByText('You won week 3!')).toBeInTheDocument();
    expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
  });
});

const side = (teamId: string, score: number) => ({
  teamId,
  teamName: teamId === 'team-1' ? "Alice's Team" : `Team ${teamId}`,
  seed: 1,
  score,
  from: 'Seed 1'
});

function bracket(champion: string | null, finalWinner: string | null): PlayoffBracketData {
  return {
    status: champion === null ? 'in_progress' : 'complete',
    teams: 4,
    byes: 0,
    weeks: [16, 17],
    reseed: false,
    consolation: false,
    seeds: [
      { seed: 1, teamId: 'team-1', teamName: "Alice's Team" },
      { seed: 2, teamId: 'team-2', teamName: 'Team team-2' }
    ],
    games: [
      {
        id: 'championship-r1-g1',
        bracket: 'championship',
        round: 1,
        week: 16,
        home: side('team-1', 100),
        away: side('team-4', 90),
        winnerTeamId: 'team-1',
        decidedBySeed: false
      },
      {
        id: 'championship-r2-g1',
        bracket: 'championship',
        round: 2,
        week: 17,
        home: side('team-1', 120),
        away: side('team-2', 99),
        winnerTeamId: finalWinner,
        decidedBySeed: false
      }
    ],
    championTeamId: champion,
    consolationChampionTeamId: null
  };
}

describe('playoff moments', () => {
  it('names the moment: the title, else your latest playoff win', () => {
    expect(playoffMoment(bracket('team-1', 'team-1'), 'team-1')).toEqual({
      kind: 'title',
      key: 'title:championship-r2-g1:120.00-99.00'
    });
    expect(playoffMoment(bracket(null, null), 'team-1')).toEqual({
      kind: 'advance',
      key: 'advance:championship-r1-g1:100.00-90.00'
    });
    expect(playoffMoment(bracket('team-2', 'team-2'), 'team-4')).toBeNull();
    expect(playoffMoment(bracket('team-1', 'team-1'), null)).toBeNull();
    const unscored = bracket(null, null);
    unscored.games[0]!.home.score = null;
    expect(playoffMoment(unscored, 'team-1')?.key).toBe('advance:championship-r1-g1:--90.00');
  });

  it('throws the big show once for a title, with the trophy', async () => {
    const getPlayoffBracket = vi.fn(async () => bracket('team-1', 'team-1'));
    const first = open('/leagues/L1/standings?view=playoffs', { getPlayoffBracket });
    expect(await screen.findByText('You are the league champion!')).toBeInTheDocument();
    expect(screen.getByTestId('confetti')).toHaveAttribute('data-size', 'big');
    expect(screen.getByText(/Champion: Alice's Team/)).toBeInTheDocument();
    first.view.unmount();

    open('/leagues/L1/standings?view=playoffs', { getPlayoffBracket });
    expect(await screen.findByText(/Champion: Alice's Team/)).toBeInTheDocument();
    expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
  });

  it('celebrates advancing in the playoffs', async () => {
    open('/leagues/L1/standings?view=playoffs', {
      getPlayoffBracket: vi.fn(async () => bracket(null, null))
    });
    expect(await screen.findByText('You won your playoff game. On to the next round!')).toBeInTheDocument();
  });
});

describe('history trophies', () => {
  it('reveals a trophy for each champion', async () => {
    const base = await fakeApi().getLeagueHistory('L1');
    const season = (year: number, championName: string | null) => ({
      season: year,
      championTeamId: championName === null ? null : 't1',
      championName,
      runnerUpTeamId: null,
      finalStandings: [],
      records: base.current.records,
      completedAt: `${year}-12-30T00:00:00Z`
    });
    open('/leagues/L1/standings?view=history', {
      getLeagueHistory: vi.fn(async () => ({
        ...base,
        seasons: [season(2025, 'Team t1'), season(2024, null), season(2023, 'Robots')]
      }))
    });
    expect(await screen.findByText('Team t1')).toBeInTheDocument();
    const trophies = screen.getAllByTestId('trophy');
    expect(trophies).toHaveLength(2);
    expect(trophies[1]).toHaveStyle({ '--motion-i': '2' });
  });
});

describe('league shell', () => {
  it('cross-fades between sections where the browser supports view transitions', async () => {
    const start = vi.fn((update: () => void) => update());
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true });
    try {
      const user = userEvent.setup();
      open('/leagues/L1/matchup', { getMatchup: vi.fn(async () => matchup('scheduled', null, null)) });
      await screen.findByTestId('league-section-matchup');
      const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
      await user.click(within(nav).getByRole('link', { name: 'Scoreboard' }));
      expect(await screen.findByTestId('league-page-scoreboard')).toBeInTheDocument();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
  });

  it('has no team outside a league layout', () => {
    const { result } = renderHook(() => useYourTeamId(), { wrapper: MemoryRouter });
    expect(result.current).toBeNull();
  });
});
