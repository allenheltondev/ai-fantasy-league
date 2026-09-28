import { FixedClock } from '@fantasy/core';
import type { DataProvider, LiveGame } from '@fantasy/data';
import { describe, expect, it, vi } from 'vitest';
import { ALICE, BOB } from '../../test/support/leagues.js';
import {
  liveGame,
  MONDAY_KICKOFF,
  nflGames,
  redZoneGame,
  seedNflSchedule,
  seedSeasonLeague,
  SUNDAY_KICKOFF
} from '../../test/support/season.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger, type Logger } from '../log.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { STATS_GAME_DURATION_MS } from '../season/window.js';
import { refreshNflGames } from './nfl-games.js';
import { scoreLiveWeek } from './season.js';

const WEEK1 = nflGames(1);
const HOUR = 3_600_000;

/** Two in-season leagues on week 1, and a provider serving `games` (as a mutable box). */
async function setup() {
  const repos = createInMemoryRepos();
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const warn = vi.fn();
  const log: Logger = { ...silentLogger, warn };
  await seedNflSchedule(reference);
  const leagueDeps = { repos, reference, events, log };
  await seedSeasonLeague(leagueDeps, { id: 'lg-a', owners: [ALICE] });
  await seedSeasonLeague(leagueDeps, { id: 'lg-b', owners: [BOB] });
  const box: { games: LiveGame[]; error: Error | null } = {
    games: WEEK1.map((g) => liveGame(g.gameId, { state: 'pre', homeScore: null, awayScore: null })),
    error: null
  };
  const getLiveGames = vi.fn(async () => {
    if (box.error) throw box.error;
    return box.games;
  });
  const provider = { getLiveGames } as unknown as DataProvider;
  const clock = new FixedClock(new Date(Date.parse(SUNDAY_KICKOFF) + HOUR));
  return { deps: { ...leagueDeps, provider }, box, getLiveGames, events, reference, warn, clock };
}

const nflEvents = (events: InMemoryEventPublisher) =>
  events.events.filter((e) => e.detailType === 'NFL Games Updated');

describe('scoreLiveWeek: the NFL games', () => {
  it('reads the games once per week however many leagues play it, and emits the first read', async () => {
    const { deps, getLiveGames, events, reference, clock } = await setup();
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({
      status: 'ok',
      live: 2,
      nflGames: { changed: 1 }
    });
    expect(getLiveGames).toHaveBeenCalledTimes(1);
    expect(getLiveGames).toHaveBeenCalledWith(2026, 1, clock.now(), expect.any(Array));
    expect(nflEvents(events)).toHaveLength(1);
    expect(nflEvents(events)[0]?.detail).toMatchObject({ season: 2026, week: 1, redZone: [] });
    expect((await reference.nflGames.get(2026, 1))?.updatedAt).toBe(clock.now().toISOString());
  });

  it('emits NFL Games Updated only when something shown changed', async () => {
    const { deps, box, events, reference, clock } = await setup();
    await scoreLiveWeek(deps, clock);

    // Two minutes later only the clock moved: stored, not emitted.
    clock.advance(2 * 60_000);
    box.games = box.games.map((g) => ({ ...g, clock: '7:59' }));
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({ nflGames: { unchanged: 1 } });
    expect(nflEvents(events)).toHaveLength(1);
    expect((await reference.nflGames.get(2026, 1))?.updatedAt).toBe(clock.now().toISOString());

    // PHI drives into the red zone.
    clock.advance(2 * 60_000);
    box.games = box.games.map((g) => (g.gameKey === '2026_01_DAL_PHI' ? redZoneGame(g.gameKey) : g));
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({ nflGames: { changed: 1 } });
    const detail = nflEvents(events)[1]?.detail as { redZone: unknown[]; games: { gameId: string }[] };
    expect(detail.redZone).toEqual([
      { team: 'PHI', downDistance: '2nd & 4 at DAL 7', fieldPosition: 'DAL 7' }
    ]);
    expect(detail.games.map((g) => g.gameId).sort()).toEqual(WEEK1.map((g) => g.gameId).sort());

    // The drive ends: the red zone clears.
    clock.advance(2 * 60_000);
    box.games = box.games.map((g) => ({ ...g, possessionTeam: null, isRedZone: false, downDistance: null }));
    await scoreLiveWeek(deps, clock);
    expect(nflEvents(events)[2]?.detail).toMatchObject({ redZone: [] });
  });

  it('never fails live scoring when the feed fails', async () => {
    const { deps, box, events, warn, clock } = await setup();
    box.error = new Error('HTTP 403');
    const result = await scoreLiveWeek(deps, clock);
    expect(result).toMatchObject({ status: 'ok', live: 2, failed: 0, nflGames: { failed: 1 } });
    expect(nflEvents(events)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'could not refresh the NFL games; live scoring goes on without them',
      expect.objectContaining({ season: 2026, week: 1, error: box.error })
    );
  });

  it('does not poll between windows, but reads after the last one until the finals are in', async () => {
    const { deps, box, getLiveGames, clock } = await setup();
    clock.set('2026-09-12T12:00:00.000Z');
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({
      reason: 'outside_game_window',
      nflGames: { idle: 1 }
    });
    expect(getLiveGames).not.toHaveBeenCalled();

    // Monday night is live, then its window closes before the game is final.
    clock.set(new Date(Date.parse(MONDAY_KICKOFF) + HOUR));
    await scoreLiveWeek(deps, clock);
    clock.set(new Date(Date.parse(MONDAY_KICKOFF) + STATS_GAME_DURATION_MS + 10 * 60_000));
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({ nflGames: { unchanged: 1 } });
    box.games = box.games.map((g) => ({ ...g, state: 'post' as const }));
    clock.advance(2 * 60_000);
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({ nflGames: { changed: 1 } });
    clock.advance(2 * 60_000);
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({ nflGames: { idle: 1 } });
    expect(getLiveGames).toHaveBeenCalledTimes(3);
  });

  it('skips a provider without live games', async () => {
    const { deps, clock } = await setup();
    const result = await refreshNflGames(
      { ...deps, provider: {} as DataProvider },
      { season: 2026, week: 1, games: WEEK1, live: true },
      clock.now()
    );
    expect(result).toBe('unavailable');
    expect(await scoreLiveWeek({ ...deps, provider: undefined }, clock)).toMatchObject({
      nflGames: { unavailable: 1 }
    });
  });
});
