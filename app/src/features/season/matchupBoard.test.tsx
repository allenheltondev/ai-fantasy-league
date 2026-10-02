import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchupData, MatchupLineup, MatchupOutlook, PlayerGame, RosterEntry } from '../../api/types';
import { mockReducedMotion } from '../../test/reducedMotion';
import { HeadToHead, pairBySlot, ScoreBar, shortName, useThrottledAnnouncement } from './MatchupBoard';

const KICKOFF = '2026-10-04T20:25:00.000Z';

function game(extra: Partial<PlayerGame> = {}): PlayerGame {
  return {
    state: 'upcoming',
    opponent: 'DAL',
    home: true,
    kickoff: KICKOFF,
    period: null,
    clock: null,
    teamScore: null,
    opponentScore: null,
    possession: false,
    redZone: false,
    progress: 0,
    ...extra
  };
}

function entry(
  id: string,
  name: string,
  slot: string,
  g: Partial<PlayerGame> = {},
  extra: Partial<RosterEntry> = {}
): RosterEntry {
  const position = extra.player?.position ?? (slot === 'BN' || slot === 'W/R/T' ? 'WR' : slot);
  const state = g.state ?? 'upcoming';
  return {
    player: { id, name, team: 'PHI', position },
    slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: 9,
    onBye: state === 'bye',
    kickoff: state === 'bye' ? null : KICKOFF,
    opponent: { team: 'DAL', home: true },
    locked: state === 'live' || state === 'final',
    projectedPoints: 18,
    points: null,
    game: game(g),
    expectedPoints: 18,
    statLine: null,
    ...extra
  };
}

const LIVE = {
  state: 'live' as const,
  period: 3,
  clock: '8:42',
  teamScore: 14,
  opponentScore: 10,
  progress: 0.6
};

const home: RosterEntry[] = [
  entry(
    'hurts',
    'Jalen Hurts',
    'QB',
    { ...LIVE, possession: true },
    {
      points: 16.52,
      expectedPoints: 19.9,
      statLine: '14/21 · 188 yds · 1 TD'
    }
  ),
  entry(
    'bijan',
    'Bijan Robinson',
    'RB',
    { state: 'final', teamScore: 27, opponentScore: 20, progress: 1 },
    {
      points: 23.4,
      player: { id: 'bijan', name: 'Bijan Robinson', team: 'ATL', position: 'RB' }
    }
  ),
  entry('cmc', 'Christian McCaffrey', 'RB', { state: 'live', progress: null }, { expectedPoints: 9 }),
  entry('jsn', 'Jaxon Smith-Njigba', 'WR', { state: 'bye', opponent: null, home: null, kickoff: null }),
  entry('jj', 'Justin Jefferson', 'W/R/T'),
  entry(
    'mahomes',
    'Patrick Mahomes',
    'BN',
    { state: 'final', teamScore: 30, opponentScore: 3 },
    { points: 24.1 }
  ),
  entry('rice', 'Rashee Rice', 'IR', {}, { status: 'ir', injuryStatus: null })
];
const away: RosterEntry[] = [
  entry('allen', 'Josh Allen', 'QB', { home: false, opponent: 'MIA' }),
  entry('gibbs', 'Jahmyr Gibbs', 'RB', { state: 'final', teamScore: 17, opponentScore: 17 }, { points: 20 }),
  entry('brown', 'A.J. Brown', 'WR', { ...LIVE, possession: true, redZone: true }, { points: 3 }),
  entry(
    'kittle',
    'George Kittle',
    'W/R/T',
    { state: 'live', progress: null },
    {
      status: 'out',
      injuryStatus: 'Out'
    }
  ),
  entry(
    'elliott',
    'Jake Elliott',
    'K',
    { ...LIVE, possession: true, redZone: true },
    {
      player: { id: 'elliott', name: 'Jake Elliott', team: 'PHI', position: 'K' },
      points: 1
    }
  ),
  entry('lamar', 'Lamar Jackson', 'BN', {}, { points: null })
];

const lineup = (teamId: string, players: RosterEntry[], projectedPoints?: number): MatchupLineup => ({
  teamId,
  points: 40,
  ...(projectedPoints === undefined ? {} : { projectedPoints }),
  players
});

function data(status: 'scheduled' | 'in_progress' | 'final' = 'in_progress', mine = 64.12, theirs = 24) {
  return {
    matchup: {
      id: 'W04-1',
      status,
      home: { teamId: 'team-1', teamName: "Alice's Team", score: mine },
      away: { teamId: 'team-2', teamName: 'Robots', score: theirs }
    } as NonNullable<MatchupData['matchup']>,
    lineups: { home: lineup('team-1', home, 111.9), away: lineup('team-2', away) }
  };
}

let motion: ReturnType<typeof mockReducedMotion>;
beforeEach(() => {
  motion = mockReducedMotion(false);
});
afterEach(() => {
  motion.restore();
  vi.useRealTimers();
});

function renderBoard(props: Partial<Parameters<typeof HeadToHead>[0]> = {}, d = data()) {
  return render(
    <MemoryRouter>
      <HeadToHead
        matchup={d.matchup}
        lineups={d.lineups}
        yourSide="home"
        editLineup="/leagues/L1/team/lineup"
        redZone={[{ team: 'PHI', downDistance: '2nd & 4 at DAL 7', fieldPosition: 'DAL 7' }]}
        {...props}
      />
    </MemoryRouter>
  );
}

const cell = (id: string) => screen.getByTestId(`h2h-player-${id}`);

describe('HeadToHead', () => {
  it('pairs the starters slot by slot, with an empty cell where a side has nobody', () => {
    renderBoard();
    const qb = screen.getByTestId('h2h-row-QB-0');
    expect(within(qb).getByRole('rowheader')).toHaveTextContent('QB');
    expect(qb).toHaveTextContent('Jalen Hurts');
    expect(qb).toHaveTextContent('Josh Allen');
    // Their second RB slot is empty; my K and TE slots are.
    expect(screen.getByTestId('h2h-row-RB-1')).toHaveTextContent('Empty');
    expect(screen.getByTestId('h2h-row-K-0')).toHaveTextContent('Empty');
  });

  it('shows a live player with the dot, the quarter and score, the ball, his box score, and a live projection', () => {
    renderBoard();
    const hurts = cell('hurts');
    expect(hurts).toHaveAttribute('data-state', 'live');
    expect(hurts).toHaveClass('h2h-live', 'h2h-edge-start');
    expect(hurts.querySelector('.motion-live-dot')).not.toBeNull();
    expect(within(hurts).getByTestId('game-context')).toHaveTextContent('Q3 8:42·vs DAL 14–10has the ball');
    expect(within(hurts).getByTestId('stat-line')).toHaveTextContent('14/21 · 188 yds · 1 TD');
    const row = screen.getByTestId('h2h-row-QB-0');
    const [mine] = within(row).getAllByTestId('player-points');
    expect(mine).toHaveTextContent('Points 16.52');
    expect(within(row).getAllByTestId('player-projection')[0]).toHaveTextContent('Projected final proj 19.9');
    // A lock on your own locked players only.
    expect(within(hurts).getByRole('img', { name: 'Locked: game started' })).toBeInTheDocument();
    expect(within(cell('brown')).queryByTestId('lock-mark')).toBeNull();
  });

  it('says Live for a started game not read yet, and Final with the result', () => {
    renderBoard();
    expect(within(cell('cmc')).getByTestId('game-context')).toHaveTextContent(/^Live·vs DAL$/);
    const bijan = cell('bijan');
    expect(bijan).toHaveAttribute('data-state', 'final');
    expect(bijan).not.toHaveClass('h2h-live');
    expect(within(bijan).getByTestId('game-context')).toHaveTextContent('Final W 27–20');
    expect(within(cell('gibbs')).getByTestId('game-context')).toHaveTextContent('Final T 17–17');
    expect(within(cell('allen')).getByTestId('game-context')).toHaveTextContent(/@ MIA$/);
  });

  it('flags a starter on bye or ruled out with a warning chip in words', () => {
    renderBoard();
    const jsn = cell('jsn');
    expect(jsn).toHaveAttribute('data-state', 'bye');
    expect(within(jsn).getByTestId('sits-out')).toHaveTextContent('BYE: scores nothing this week');
    const kittle = cell('kittle');
    expect(kittle).toHaveAttribute('data-state', 'out');
    expect(kittle).not.toHaveClass('h2h-live');
    expect(within(kittle).getByTestId('sits-out')).toHaveTextContent('OUT: scores nothing this week');
    expect(within(kittle).getByTestId('game-context')).toHaveTextContent('Live · vs DAL');
    // No projection for a player who will not score, and a dash with words for no points yet.
    const row = screen.getByTestId('h2h-row-W/R/T-0');
    expect(within(row).getAllByTestId('player-projection')).toHaveLength(1);
    expect(within(row).getAllByTestId('player-points')[1]).toHaveTextContent('No points yet');
  });

  it('highlights a red-zone drive, with its down and distance, but not for a kicker who pulses too little to matter', () => {
    renderBoard();
    const brown = cell('brown');
    expect(brown).toHaveClass('h2h-redzone', 'h2h-edge-end', 'h2h-pulse');
    expect(within(brown).getByTestId('red-zone-chip')).toHaveTextContent('Red zone·2nd & 4 at DAL 7');
    expect(within(brown).queryByTestId('ball-mark')).toBeNull();
    // A kicker scores from the drive too.
    expect(cell('elliott')).toHaveClass('h2h-redzone');
  });

  it('keeps the red zone still under reduced motion', () => {
    motion.set(true);
    renderBoard();
    expect(cell('brown')).toHaveClass('h2h-redzone');
    expect(cell('brown')).not.toHaveClass('h2h-pulse');
  });

  it('collapses the bench under its totals and opens it', async () => {
    renderBoard();
    const toggle = screen.getByRole('button', { name: 'Bench' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('h2h-bench')).not.toBeVisible();
    expect(toggle.closest('tr')).toHaveTextContent('24.10 ptsBench▾0.00 pts');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const bench = screen.getByTestId('h2h-bench');
    expect(bench).toBeVisible();
    expect(within(bench).getByTestId('h2h-row-BN-0')).toHaveTextContent('Patrick Mahomes');
    expect(within(bench).getByTestId('h2h-row-BN-0')).toHaveTextContent('Lamar Jackson');
    expect(within(bench).getByTestId('h2h-row-IR-0')).toHaveTextContent('Rashee Rice');
  });

  it('offers Edit lineup while one of your players can still move', () => {
    const { unmount } = renderBoard();
    expect(screen.getByRole('link', { name: 'Edit lineup' })).toHaveAttribute(
      'href',
      '/leagues/L1/team/lineup'
    );
    unmount();
    renderBoard({ editLineup: null });
    expect(screen.queryByRole('link', { name: 'Edit lineup' })).toBeNull();
  });

  it('shows no locks or edit link on someone else’s matchup, and none when everyone is locked', () => {
    const { unmount } = renderBoard({ yourSide: null });
    expect(screen.queryByTestId('lock-mark')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit lineup' })).toBeNull();
    unmount();
    const locked = data();
    locked.lineups.home = lineup(
      'team-1',
      home.map((p) => ({ ...p, locked: true }))
    );
    renderBoard({}, locked);
    expect(screen.queryByRole('link', { name: 'Edit lineup' })).toBeNull();
  });

  it('works for an older response without game states or a bench', () => {
    const plain = (id: string, slot: string, extra: Partial<RosterEntry> = {}): RosterEntry => {
      const e = entry(id, id.toUpperCase(), slot, {}, extra);
      delete e.game;
      delete e.expectedPoints;
      delete e.statLine;
      return e;
    };
    const d = data();
    d.lineups = {
      home: lineup('team-1', [plain('a', 'QB', { locked: true, points: 5 })]),
      away: lineup('team-2', [
        plain('b', 'QB', { player: { id: 'b', name: 'B', team: null, position: 'QB' } })
      ])
    };
    renderBoard({}, d);
    expect(cell('a')).toHaveAttribute('data-state', 'live');
    // Live without an expected figure: the plain projection.
    expect(
      within(screen.getByTestId('h2h-row-QB-0')).getAllByTestId('player-projection')[0]
    ).toHaveTextContent('18.0');
    expect(cell('b')).toHaveTextContent('QB · FA');
  });

  it('shows a final without a score read as Final against the opponent', () => {
    const d = data();
    d.lineups = {
      home: lineup('team-1', [entry('a', 'A', 'QB', { state: 'final' })]),
      away: lineup('team-2', [])
    };
    renderBoard({}, d);
    expect(within(cell('a')).getByTestId('game-context')).toHaveTextContent('Final vs DAL');
    expect(screen.queryByRole('button', { name: 'Bench' })).toBeNull();
  });
});

describe('ScoreBar', () => {
  it('shows the predicted win probability in the header, home side first', () => {
    const d = data();
    const team = (teamId: string, winProbability: number) => ({
      teamId,
      teamName: teamId,
      currentPoints: 0,
      projectedPoints: 100,
      remainingPoints: 100,
      playersYetToPlay: 0,
      playersInProgress: 0,
      winProbability
    });
    const outlook = {
      week: 4,
      teamId: d.matchup.away.teamId,
      status: 'in_progress',
      you: team(d.matchup.away.teamId, 0.3),
      opponent: team(d.matchup.home.teamId, 0.7)
    } as unknown as MatchupOutlook;
    render(
      <MemoryRouter>
        <ScoreBar week={4} matchup={d.matchup} lineups={d.lineups} leader={null} outlook={outlook} />
      </MemoryRouter>
    );
    expect(screen.getByTestId('win-probability-home')).toHaveTextContent('70%');
    expect(screen.getByTestId('win-probability-away')).toHaveTextContent('30%');
    expect(screen.getByTestId('win-probability-bar')).toHaveStyle({ width: '70%' });
  });

  function renderBar(d = data(), leader: string | null = 'team-1') {
    return render(
      <MemoryRouter>
        <ScoreBar week={4} matchup={d.matchup} lineups={d.lineups} leader={leader} />
      </MemoryRouter>
    );
  }

  it('leads with the totals, then the live projection and who is playing', () => {
    renderBar();
    const mine = screen.getByRole('region', { name: "Alice's Team" });
    expect(mine).toHaveAttribute('data-leading', 'true');
    expect(within(mine).getByTestId('score-team-1')).toHaveTextContent('64.12');
    expect(within(mine).getByTestId('projected-team-1')).toHaveTextContent('Proj 111.9');
    expect(within(mine).getByTestId('status-counts')).toHaveTextContent(
      '2 playing · 1 to play · 1 done · 1 out'
    );
    const pips = within(mine).getByTestId('status-pips');
    expect(pips).toHaveAttribute('aria-hidden', 'true');
    expect([...pips.children].map((p) => p.getAttribute('data-state'))).toEqual([
      'live',
      'live',
      'upcoming',
      'final',
      'out'
    ]);
    // Their side: trailing, muted, and no projection on an older response.
    const theirs = screen.getByRole('region', { name: 'Robots' });
    expect(within(theirs).getByTestId('score-team-2')).toHaveClass('text-muted-foreground');
    expect(within(theirs).queryByTestId('projected-team-2')).toBeNull();
    expect(within(theirs).getByTestId('status-counts')).toHaveTextContent(
      '2 playing · 1 to play · 1 done · 1 out'
    );
    expect(screen.getByTestId('score-bar')).toHaveClass('h2h-bar-live');
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows a final or upcoming week without the live rule', () => {
    const d = data('final', 0, 0);
    d.matchup.home.score = null;
    renderBar(d, null);
    expect(screen.getByText('Final')).toBeInTheDocument();
    expect(screen.getByTestId('score-bar')).not.toHaveClass('h2h-bar-live');
    expect(screen.getByTestId('score-team-1')).toHaveTextContent('0.00');
    expect(screen.getByTestId('score-team-1')).not.toHaveClass('text-muted-foreground');
  });
});

describe('score announcements', () => {
  it('says nothing on load, then the latest score at most once per window', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { result, rerender } = renderHook(({ m }) => useThrottledAnnouncement(m, 30_000), {
      initialProps: { m: 'A 1, B 0.' }
    });
    expect(result.current).toBe('');
    rerender({ m: 'A 7, B 0.' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe('A 7, B 0.');
    // A burst inside the window: only the last one is read, when the window ends.
    rerender({ m: 'A 8, B 0.' });
    rerender({ m: 'A 8, B 3.' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toBe('A 7, B 0.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(result.current).toBe('A 8, B 3.');
    // Back to the first score: still news.
    rerender({ m: 'A 1, B 0.' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe('A 1, B 0.');
  });
});

describe('helpers', () => {
  it('shortens names for the phone column', () => {
    expect(shortName('Christian McCaffrey')).toBe('C. McCaffrey');
    expect(shortName('Amon-Ra St. Brown')).toBe('A. St. Brown');
    expect(shortName('49ers')).toBe('49ers');
  });

  it('pairs only the slots asked for', () => {
    expect(
      pairBySlot(home, away, (s) => s === 'QB').map((p) => [p.home?.player.id, p.away?.player.id])
    ).toEqual([['hurts', 'allen']]);
  });
});
