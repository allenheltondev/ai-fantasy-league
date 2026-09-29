import { describe, expect, it } from 'vitest';
import {
  clockSeconds,
  gameProgress,
  OVERTIME_PROGRESS,
  playerGame,
  stillToPlay,
  type NflGameRead
} from './game-state.js';

const KICKOFF = '2026-10-04T17:00:00.000Z';
const BEFORE = '2026-10-04T16:00:00.000Z';
const DURING = '2026-10-04T18:30:00.000Z';

const game = (extra: Partial<NflGameRead> = {}): NflGameRead => ({
  homeTeam: 'PHI',
  awayTeam: 'DAL',
  kickoff: KICKOFF,
  state: 'pre',
  homeScore: null,
  awayScore: null,
  period: null,
  clock: null,
  possessionTeam: null,
  isRedZone: false,
  ...extra
});

const live = game({
  state: 'in',
  homeScore: 17,
  awayScore: 10,
  period: 3,
  clock: '8:42',
  possessionTeam: 'PHI',
  isRedZone: true
});

describe('clockSeconds', () => {
  it('reads m:ss clocks and refuses anything else', () => {
    expect(clockSeconds('8:42')).toBe(522);
    expect(clockSeconds('15:00')).toBe(900);
    expect(clockSeconds('0:07.4')).toBe(7);
    expect(clockSeconds(null)).toBeNull();
    expect(clockSeconds('Halftime')).toBeNull();
    expect(clockSeconds('16:00')).toBeNull();
  });
});

describe('gameProgress', () => {
  it('is the share of regulation played', () => {
    expect(gameProgress(1, '15:00')).toBe(0);
    expect(gameProgress(2, '0:00')).toBe(0.5);
    expect(gameProgress(3, '8:42')).toBe(0.605);
    expect(gameProgress(4, '0:00')).toBe(1);
  });

  it('uses the quarter midpoint without a clock, counts overtime as nearly done, and is null without a quarter', () => {
    expect(gameProgress(2, null)).toBe(0.375);
    expect(gameProgress(5, '6:00')).toBe(OVERTIME_PROGRESS);
    expect(gameProgress(null, '8:42')).toBeNull();
    expect(gameProgress(0, '8:42')).toBeNull();
  });
});

describe('playerGame', () => {
  it('is upcoming before kickoff, with the opponent and home side', () => {
    expect(playerGame('DAL', [game()], BEFORE)).toEqual({
      state: 'upcoming',
      opponent: 'PHI',
      home: false,
      kickoff: KICKOFF,
      period: null,
      clock: null,
      teamScore: null,
      opponentScore: null,
      possession: false,
      redZone: false,
      progress: 0
    });
  });

  it('is live from the feed, with the score from his side, the ball, and the red zone', () => {
    expect(playerGame('PHI', [live], DURING)).toEqual({
      state: 'live',
      opponent: 'DAL',
      home: true,
      kickoff: KICKOFF,
      period: 3,
      clock: '8:42',
      teamScore: 17,
      opponentScore: 10,
      possession: true,
      redZone: true,
      progress: 0.605
    });
    expect(playerGame('DAL', [live], DURING)).toMatchObject({
      teamScore: 10,
      opponentScore: 17,
      possession: false,
      redZone: false
    });
  });

  it('counts a started game with no read yet as live, with unknown progress', () => {
    expect(playerGame('PHI', [game()], DURING)).toMatchObject({
      state: 'live',
      progress: null,
      clock: null,
      teamScore: null
    });
  });

  it('is final as soon as the feed says so, even before the schedule catches up', () => {
    const post = game({ state: 'post', homeScore: 27, awayScore: 20, period: 4 });
    expect(playerGame('PHI', [post], DURING)).toMatchObject({
      state: 'final',
      teamScore: 27,
      opponentScore: 20,
      progress: 1,
      clock: null,
      possession: false
    });
  });

  it('assumes a game long past kickoff is final when asked to', () => {
    const later = '2026-10-05T03:00:00.000Z';
    expect(playerGame('PHI', [live], later).state).toBe('live');
    expect(playerGame('PHI', [live], later, { finalAfterMs: 8 * 3_600_000 })).toMatchObject({
      state: 'final',
      progress: 1
    });
  });

  it('is a bye without a team, without a game, or when the game has no kickoff', () => {
    expect(playerGame(null, [live], DURING).state).toBe('bye');
    expect(playerGame('SEA', [live], DURING)).toMatchObject({ state: 'bye', opponent: null, progress: null });
    expect(
      playerGame('PHI', [game({ kickoff: null, state: 'in', period: 1, clock: '3:00' })], DURING)
    ).toMatchObject({
      state: 'live',
      kickoff: null
    });
    expect(playerGame('PHI', [game({ kickoff: null })], new Date(DURING)).state).toBe('upcoming');
  });
});

describe('stillToPlay', () => {
  it('is true for upcoming and live games only', () => {
    expect(
      ['upcoming', 'live', 'final', 'bye'].map((state) => stillToPlay({ state: state as 'live' }))
    ).toEqual([true, true, false, false]);
  });
});
