import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeagueApiContext } from '../../api/league';
import type { MatchupData, NflGame, NflGamesData, RosterEntry } from '../../api/types';
import type { EventConnect, LeagueEvent } from '../../realtime/leagueEvents';
import { fakeApi } from '../../test/fakeApi';
import { MatchupPage } from './MatchupPage';
import { GameCard, gameStatus, NflGamesStrip, orderGames } from './NflGamesStrip';
import { RedZoneChip, redZoneClass, redZoneFor, usePrefersReducedMotion } from './RedZone';

function entry(id: string, position: string, team: string | null, slot = position): RosterEntry {
  return {
    player: { id, name: id.toUpperCase(), team, position },
    slot,
    status: 'active',
    injuryStatus: null,
    byeWeek: 10,
    onBye: false,
    kickoff: '2026-10-04T17:00:00.000Z',
    locked: true,
    projectedPoints: 10,
    points: 4
  };
}

function game(home: string, away: string, extra: Partial<NflGame> = {}): NflGame {
  return {
    gameId: `2026_04_${away}_${home}`,
    homeTeam: home,
    awayTeam: away,
    homeScore: 14,
    awayScore: 10,
    kickoff: '2026-10-04T17:00:00.000Z',
    state: 'in',
    status: '8:32 - 2nd',
    period: 2,
    clock: '8:32',
    possessionTeam: null,
    isRedZone: false,
    downDistance: null,
    fieldPosition: null,
    yardsToGoal: null,
    ...extra
  };
}

const RED = game('PHI', 'DAL', {
  possessionTeam: 'PHI',
  isRedZone: true,
  downDistance: '2nd & 4 at DAL 7',
  fieldPosition: 'DAL 7',
  yardsToGoal: 7
});
const DRIVING = game('NYG', 'WAS', {
  possessionTeam: 'WAS',
  downDistance: '1st & 10 at WAS 35',
  fieldPosition: 'WAS 35',
  yardsToGoal: 65
});
const PREGAME = game('SF', 'LAR', {
  state: 'pre',
  status: null,
  homeScore: null,
  awayScore: null,
  period: null,
  clock: null,
  kickoff: '2026-10-04T20:25:00.000Z'
});
const FINAL = game('JAX', 'KC', {
  state: 'post',
  status: 'Final',
  clock: null,
  homeScore: 24,
  awayScore: 27
});

function gamesData(games: NflGame[]): NflGamesData {
  return {
    season: 2026,
    week: 4,
    games,
    redZone: games.flatMap((g) =>
      g.isRedZone && g.possessionTeam !== null
        ? [{ team: g.possessionTeam, downDistance: g.downDistance, fieldPosition: g.fieldPosition }]
        : []
    ),
    updatedAt: '2026-10-04T18:30:00.000Z'
  };
}

/** Stubs `prefers-reduced-motion`, with a way to flip it. */
function reducedMotion(initial: boolean) {
  const listeners = new Set<() => void>();
  const state = { matches: initial };
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media: string) =>
      ({
        get matches() {
          return media.includes('reduce') && state.matches;
        },
        media,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
      }) as unknown as MediaQueryList
  );
  return {
    set(value: boolean) {
      state.matches = value;
      listeners.forEach((fn) => fn());
    },
    listeners
  };
}

afterEach(() => vi.restoreAllMocks());

describe('red-zone helpers', () => {
  const zone = { team: 'PHI', downDistance: '2nd & 4 at DAL 7', fieldPosition: 'DAL 7' };

  it('highlights offensive players on a red-zone team only', () => {
    for (const position of ['QB', 'RB', 'WR', 'TE', 'K']) {
      expect(redZoneFor(entry('p', position, 'PHI'), [zone])).toBe(zone);
    }
    expect(redZoneFor(entry('d', 'DEF', 'PHI'), [zone])).toBeNull();
    expect(redZoneFor(entry('f', 'WR', null), [zone])).toBeNull();
    expect(redZoneFor(entry('o', 'WR', 'DAL'), [zone])).toBeNull();
  });

  it('pulses unless motion is reduced', () => {
    expect(redZoneClass('red-zone-row', false)).toBe('red-zone-row red-zone-pulse');
    expect(redZoneClass('red-zone-card', true)).toBe('red-zone-card');
  });

  it('says "Red zone" with the down and distance, in text', () => {
    const { rerender } = render(<RedZoneChip zone={zone} />);
    expect(screen.getByTestId('red-zone-chip')).toHaveTextContent('Red zone·2nd & 4 at DAL 7');
    rerender(<RedZoneChip zone={{ ...zone, downDistance: null }} />);
    expect(screen.getByTestId('red-zone-chip')).toHaveTextContent(/^Red zone$/);
  });

  it('follows the reduced-motion setting', () => {
    const motion = reducedMotion(false);
    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => motion.set(true));
    expect(result.current).toBe(true);
    unmount();
    expect(motion.listeners.size).toBe(0);
  });
});

describe('the NFL games strip', () => {
  it('orders my players’ games first, then live, upcoming, and final', () => {
    const games = [FINAL, PREGAME, game('BUF', 'MIA', { kickoff: '2026-10-04T16:00:00.000Z' }), RED];
    expect(orderGames(games, new Set(['KC'])).map((g) => g.homeTeam)).toEqual(['JAX', 'BUF', 'PHI', 'SF']);
    expect(orderGames([{ ...PREGAME, kickoff: null }, PREGAME], new Set()).map((g) => g.kickoff)).toEqual([
      null,
      PREGAME.kickoff
    ]);
  });

  it('shows the feed’s status, or builds one', () => {
    expect(gameStatus(RED)).toBe('8:32 - 2nd');
    expect(gameStatus({ ...RED, status: null, period: 3, clock: '4:12' })).toBe('Q3 4:12');
    expect(gameStatus({ ...RED, status: null, period: 5, clock: null })).toBe('OT');
    expect(gameStatus({ ...RED, status: null, period: null })).toBe('Live');
    expect(gameStatus({ ...FINAL, status: null })).toBe('Final');
    expect(gameStatus({ ...PREGAME, kickoff: null })).toBe('Upcoming');
    expect(gameStatus(PREGAME)).toMatch(/\d:25/);
  });

  it('marks the team with the ball, the red zone, and where the ball is', () => {
    render(<GameCard game={RED} reducedMotion={false} />);
    const card = screen.getByRole('article', { name: 'DAL at PHI' });
    expect(card).toHaveClass('red-zone-card', 'red-zone-pulse');
    expect(within(card).getByText('PHI')).toHaveTextContent('PHIhas the ball');
    expect(within(card).getByText('DAL')).not.toHaveTextContent('has the ball');
    expect(within(card).getByTestId('red-zone-chip')).toHaveTextContent('2nd & 4 at DAL 7');
    expect(within(card).queryByTestId('down-distance')).not.toBeInTheDocument();
    expect(
      within(card).getByRole('img', { name: 'PHI ball, 7 yards from the end zone' })
    ).toBeInTheDocument();
  });

  it('shows a drive outside the red zone plainly', () => {
    render(<GameCard game={{ ...DRIVING, yardsToGoal: 1 }} reducedMotion />);
    const card = screen.getByRole('article', { name: 'WAS at NYG' });
    expect(card).not.toHaveClass('red-zone-card');
    expect(within(card).getByText('WAS')).toHaveTextContent('has the ball');
    expect(within(card).getByTestId('down-distance')).toHaveTextContent('1st & 10 at WAS 35');
    expect(within(card).getByRole('img', { name: 'WAS ball, 1 yard from the end zone' })).toBeInTheDocument();
  });

  it('keeps a live card the same shape as the ball and red zone come and go', () => {
    const shape = (card: HTMLElement) => ({
      line: within(card).getByTestId('live-line').className,
      slot: within(card).getByTestId('field-slot').className
    });
    const { rerender } = render(<GameCard game={game('PHI', 'DAL')} reducedMotion />);
    const quiet = shape(screen.getByRole('article', { name: 'DAL at PHI' }));
    expect(within(screen.getByRole('article')).queryByTestId('field-bar')).toBeNull();
    rerender(<GameCard game={RED} reducedMotion />);
    expect(within(screen.getByRole('article')).getByTestId('field-bar')).toBeInTheDocument();
    expect(shape(screen.getByRole('article'))).toEqual(quiet);
    rerender(<GameCard game={DRIVING} reducedMotion />);
    expect(shape(screen.getByRole('article'))).toEqual(quiet);
  });

  it('shows pregame and final games without a ball', () => {
    render(
      <>
        <GameCard game={PREGAME} reducedMotion={false} />
        <GameCard game={{ ...FINAL, homeTeam: null }} reducedMotion={false} />
      </>
    );
    const pregame = screen.getByRole('article', { name: 'LAR at SF' });
    expect(pregame).toHaveAttribute('data-state', 'pre');
    expect(within(pregame).queryByText('has the ball')).not.toBeInTheDocument();
    expect(within(pregame).queryByTestId('field-bar')).not.toBeInTheDocument();
    expect(within(pregame).queryByTestId('field-slot')).not.toBeInTheDocument();
    const final = screen.getByRole('article', { name: 'KC at TBD' });
    expect(within(final).getByTestId('game-status')).toHaveTextContent('Final');
    expect(final).toHaveTextContent('27');
  });

  it("shows each team's logo beside its name, and none for a team not set yet", () => {
    render(
      <>
        <GameCard game={PREGAME} reducedMotion={false} />
        <GameCard game={{ ...FINAL, homeTeam: null }} reducedMotion={false} />
      </>
    );
    const pregame = screen.getByRole('article', { name: 'LAR at SF' });
    expect([...pregame.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'https://sleepercdn.com/images/team_logos/nfl/lar.png',
      'https://sleepercdn.com/images/team_logos/nfl/sf.png'
    ]);
    // Decorative: the abbreviation is right beside it.
    expect(pregame.querySelector('img')).toHaveAttribute('alt', '');
    const final = screen.getByRole('article', { name: 'KC at TBD' });
    expect(final.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders nothing without games, and every game otherwise', () => {
    const { container, rerender } = render(<NflGamesStrip data={gamesData([])} featured={new Set()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <NflGamesStrip data={gamesData([FINAL, RED, { ...PREGAME, gameId: null }])} featured={new Set()} />
    );
    const strip = screen.getByRole('region', { name: 'NFL games · week 4' });
    expect(
      within(strip)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label'))
    ).toEqual(['DAL at PHI', 'LAR at SF', 'KC at JAX']);
  });
});

/** PHI has the ball: in the red zone while `drive.redZone` (the server's per-player game state, #193). */
const drive = { redZone: true };

function onDrive(e: RosterEntry): RosterEntry {
  if (e.player.team !== 'PHI') return e;
  return {
    ...e,
    game: {
      state: 'live',
      opponent: 'DAL',
      home: true,
      kickoff: '2026-10-04T17:00:00.000Z',
      period: 2,
      clock: '8:32',
      teamScore: 14,
      opponentScore: 10,
      possession: true,
      redZone: drive.redZone,
      progress: 0.4
    }
  };
}

function matchup(): MatchupData {
  return {
    week: 4,
    teamId: 'team-1',
    matchup: {
      id: 'W04-1',
      status: 'in_progress',
      home: { teamId: 'team-1', teamName: "Alice's Team", score: 20 },
      away: { teamId: 'team-2', teamName: 'Robots', score: 12 }
    },
    lineups: {
      home: {
        teamId: 'team-1',
        points: 20,
        players: [
          entry('hurts', 'QB', 'PHI'),
          entry('brown', 'WR', 'PHI'),
          entry('eagles', 'DEF', 'PHI'),
          entry('bench', 'RB', 'PHI', 'BN'),
          entry('fa', 'WR', null)
        ].map(onDrive)
      },
      away: { teamId: 'team-2', points: 12, players: [entry('mclaurin', 'WR', 'WAS')] }
    }
  };
}

function renderMatchup(games: () => NflGamesData) {
  let push: (event: LeagueEvent) => void = () => undefined;
  const connect: EventConnect = async (_target, handlers) => {
    push = handlers.onEvent;
    return () => undefined;
  };
  const api = fakeApi({
    getMatchup: vi.fn(async () => matchup()),
    getNflGames: vi.fn(async () => games()),
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
  return { api, push: (event: LeagueEvent) => act(() => push(event)) };
}

const cell = (id: string) => screen.getByTestId(`h2h-player-${id}`);

describe('MatchupPage red zone and NFL games', () => {
  beforeEach(() => {
    drive.redZone = true;
  });

  it('highlights started offensive players in the red zone, and clears it when the drive ends', async () => {
    reducedMotion(false);
    let games = gamesData([RED, DRIVING, FINAL]);
    const { api, push } = renderMatchup(() => games);
    const hurts = await screen.findByTestId('h2h-player-hurts');
    expect(hurts).toHaveClass('h2h-redzone', 'h2h-pulse', 'h2h-edge-start');
    // The drive's down and distance come from the week's games once they load.
    await waitFor(() =>
      expect(within(hurts).getByTestId('red-zone-chip')).toHaveTextContent('Red zone·2nd & 4 at DAL 7')
    );
    expect(cell('brown')).toHaveClass('h2h-redzone');
    // A defense is not highlighted (its offense has the ball), nor a player without a team.
    expect(cell('eagles')).not.toHaveClass('h2h-redzone');
    expect(cell('eagles')).toHaveClass('h2h-live');
    expect(cell('fa')).not.toHaveClass('h2h-redzone');
    expect(cell('mclaurin')).not.toHaveClass('h2h-redzone');
    // My started players' game leads the strip.
    const strip = screen.getByRole('region', { name: 'NFL games · week 4' });
    expect(within(strip).getAllByRole('article')[0]).toHaveAccessibleName('DAL at PHI');

    await waitFor(() => expect(api.getRealtime).toHaveBeenCalled());
    games = gamesData([{ ...RED, possessionTeam: 'DAL', isRedZone: false, homeScore: 21 }, DRIVING, FINAL]);
    drive.redZone = false;
    push({ detailType: 'Scores Updated', leagueId: null });
    expect(api.getNflGames).toHaveBeenCalledTimes(1);
    push({ detailType: 'NFL Games Updated', leagueId: null });
    // NFL Games Updated reloads both the games and the matchup, where the game states live.
    await waitFor(() => expect(cell('hurts')).not.toHaveClass('h2h-redzone'));
    expect(cell('hurts')).toHaveClass('h2h-live');
    expect(screen.queryByTestId('red-zone-chip')).toBeNull();
    expect(screen.getByRole('article', { name: 'DAL at PHI' })).toHaveTextContent('21');
  });

  it('re-reads the matchup, not the games or the log, when a player’s status changes (#200)', async () => {
    const { api, push } = renderMatchup(() => gamesData([RED]));
    await screen.findByTestId('h2h-player-hurts');
    await waitFor(() => expect(api.getRealtime).toHaveBeenCalled());
    const reads = vi.mocked(api.getMatchup).mock.calls.length;
    push({ detailType: 'Player Status Changed', leagueId: null, detail: { playerId: 'hurts' } });
    await waitFor(() => expect(api.getMatchup).toHaveBeenCalledTimes(reads + 1));
    expect(api.getNflGames).toHaveBeenCalledTimes(1);
  });

  it('keeps the highlight but drops the pulse for reduced motion', async () => {
    reducedMotion(true);
    renderMatchup(() => gamesData([RED]));
    const hurts = await screen.findByTestId('h2h-player-hurts');
    expect(hurts).toHaveClass('h2h-redzone');
    expect(hurts).not.toHaveClass('h2h-pulse');
    await waitFor(() =>
      expect(screen.getByRole('article', { name: 'DAL at PHI' })).not.toHaveClass('red-zone-pulse')
    );
  });

  it('shows the matchup without games when they fail to load, the chip without its down and distance', async () => {
    const { api } = renderMatchup(() => {
      throw new Error('down');
    });
    const hurts = await screen.findByTestId('h2h-player-hurts');
    await waitFor(() => expect(api.getNflGames).toHaveBeenCalled());
    expect(within(hurts).getByTestId('red-zone-chip')).toHaveTextContent(/^Red zone$/);
    expect(screen.queryByTestId('nfl-games')).not.toBeInTheDocument();
  });
});
