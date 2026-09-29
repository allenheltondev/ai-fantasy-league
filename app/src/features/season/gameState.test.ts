import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerGame, RosterEntry } from '../../api/types';
import {
  countsLabel,
  gameContext,
  gameOf,
  isLockedAt,
  locksIn,
  nextKickoff,
  periodLabel,
  scoreLine,
  sitsOut,
  stateCounts,
  useNow,
  versus,
  withLocksAt
} from './gameState';

const KICKOFF = '2026-10-04T17:00:00.000Z';
const T = Date.parse(KICKOFF);

export function game(extra: Partial<PlayerGame> = {}): PlayerGame {
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

export function player(extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    player: { id: 'p', name: 'Jalen Hurts', team: 'PHI', position: 'QB' },
    slot: 'QB',
    status: 'active',
    injuryStatus: null,
    byeWeek: 9,
    onBye: false,
    kickoff: KICKOFF,
    opponent: { team: 'DAL', home: true },
    locked: false,
    projectedPoints: 20,
    points: null,
    ...extra
  };
}

afterEach(() => vi.useRealTimers());

describe('game wording', () => {
  it('derives a game for older responses without one', () => {
    expect(gameOf(player()).state).toBe('upcoming');
    expect(gameOf(player({ locked: true })).state).toBe('live');
    expect(gameOf(player({ onBye: true, kickoff: null, opponent: null }))).toMatchObject({
      state: 'bye',
      opponent: null,
      home: null
    });
    expect(gameOf(player({ opponent: undefined })).opponent).toBeNull();
    expect(gameOf(player({ game: game({ state: 'final' }) })).state).toBe('final');
  });

  it('says vs at home and @ away', () => {
    expect(versus({ opponent: 'DAL', home: true })).toBe('vs DAL');
    expect(versus({ opponent: 'DAL', home: false })).toBe('@ DAL');
    expect(versus({ opponent: null, home: null })).toBe('');
  });

  it('labels quarters, halftime, and overtime', () => {
    expect(periodLabel(null, null)).toBeNull();
    expect(periodLabel(3, '8:42')).toBe('Q3 8:42');
    expect(periodLabel(1, null)).toBe('Q1');
    expect(periodLabel(2, '0:00')).toBe('Halftime');
    expect(periodLabel(2, '00:00')).toBe('Halftime');
    expect(periodLabel(5, '6:00')).toBe('OT 6:00');
    expect(periodLabel(6, null)).toBe('2OT');
  });

  it('scores from his side, with the result once final', () => {
    expect(scoreLine(game(), false)).toBeNull();
    expect(scoreLine(game({ teamScore: 14, opponentScore: 10 }), false)).toBe('14–10');
    expect(scoreLine(game({ teamScore: 27, opponentScore: 20 }), true)).toBe('W 27–20');
    expect(scoreLine(game({ teamScore: 17, opponentScore: 24 }), true)).toBe('L 17–24');
    expect(scoreLine(game({ teamScore: 17, opponentScore: 17 }), true)).toBe('T 17–17');
  });

  it('writes the game line for every state', () => {
    expect(gameContext(player({ game: game() }))).toMatch(/^\w{3},? \d{1,2}:\d{2}\s[AP]M vs DAL$/);
    expect(gameContext(player({ game: game({ kickoff: null }) }))).toBe('vs DAL');
    expect(
      gameContext(
        player({ game: game({ state: 'live', period: 3, clock: '8:42', teamScore: 14, opponentScore: 10 }) })
      )
    ).toBe('Q3 8:42 · vs DAL 14–10');
    expect(gameContext(player({ game: game({ state: 'live', home: false }) }))).toBe('Live · @ DAL');
    expect(gameContext(player({ game: game({ state: 'final', teamScore: 27, opponentScore: 20 }) }))).toBe(
      'Final · W 27–20'
    );
    expect(gameContext(player({ game: game({ state: 'final' }) }))).toBe('Final · vs DAL');
    expect(gameContext(player({ game: game({ state: 'bye' }) }))).toBe('BYE');
  });
});

describe('who is playing', () => {
  it('sits out a starter on bye, or ruled out until his game is final', () => {
    expect(sitsOut(player({ game: game({ state: 'bye' }) }))).toBe(true);
    expect(sitsOut(player({ status: 'out' }))).toBe(true);
    expect(sitsOut(player({ status: 'out', game: game({ state: 'live' }) }))).toBe(true);
    expect(sitsOut(player({ status: 'out', game: game({ state: 'final' }) }))).toBe(false);
    expect(sitsOut(player({ status: 'questionable' }))).toBe(false);
  });

  it('counts the starters by state and says so in words', () => {
    const counts = stateCounts([
      player({ game: game({ state: 'live' }) }),
      player({ game: game({ state: 'live' }), status: 'out' }),
      player({ game: game() }),
      player({ game: game({ state: 'final' }) }),
      player({ game: game({ state: 'bye' }) }),
      player({ slot: 'BN', game: game({ state: 'live' }) })
    ]);
    expect(counts).toEqual({ playing: 1, toPlay: 1, done: 1, out: 2 });
    expect(countsLabel(counts)).toBe('1 playing · 1 to play · 1 done · 2 out');
    expect(countsLabel({ playing: 0, toPlay: 3, done: 0, out: 0 })).toBe('3 to play');
    expect(countsLabel({ playing: 0, toPlay: 0, done: 0, out: 0 })).toBe('No starters');
  });
});

describe('locks', () => {
  it('counts down the last hour before kickoff', () => {
    expect(locksIn(player(), T - 2 * 3_600_000)).toBeNull();
    expect(locksIn(player(), T - 12 * 60_000)).toBe('Locks in 12m');
    expect(locksIn(player(), T - 20_000)).toBe('Locks in 1m');
    expect(locksIn(player(), T)).toBeNull();
    expect(locksIn(player({ kickoff: null, onBye: true }), T)).toBeNull();
    expect(locksIn(player({ locked: true }), T - 60_000)).toBeNull();
  });

  it('locks at kickoff by the clock, never a player on bye', () => {
    expect(isLockedAt(player(), T - 1)).toBe(false);
    expect(isLockedAt(player(), T)).toBe(true);
    expect(isLockedAt(player({ onBye: true }), T + 1)).toBe(false);
    expect(isLockedAt(player({ kickoff: null }), T + 1)).toBe(false);
    const before = [player(), player({ locked: true })];
    expect(withLocksAt(before, T - 1)[0]).toBe(before[0]);
    expect(withLocksAt(before, T).map((p) => p.locked)).toEqual([true, true]);
    expect(withLocksAt(before, T)[1]).toBe(before[1]);
  });

  it('finds the next kickoff', () => {
    const later = '2026-10-04T20:25:00.000Z';
    const players = [player({ kickoff: later }), player(), player({ kickoff: null })];
    expect(nextKickoff(players, T - 1)).toBe(T);
    expect(nextKickoff(players, T)).toBe(Date.parse(later));
    expect(nextKickoff(players, Date.parse(later))).toBeNull();
  });

  it('ticks, and lands exactly on the next boundary', async () => {
    vi.useFakeTimers({ now: T - 90_000 });
    const { result, unmount } = renderHook(() => useNow(60_000, (now) => (now < T ? T : null)));
    expect(result.current).toBe(T - 90_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe(T - 30_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current).toBe(T);
    unmount();
    const plain = renderHook(() => useNow(1_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(plain.result.current).toBe(T + 1_000);
  });
});
