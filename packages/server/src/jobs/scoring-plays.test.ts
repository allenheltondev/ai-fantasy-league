import { FixedClock } from '@fantasy/core';
import type { DataProvider, LiveGame, ScoringPlay } from '@fantasy/data';
import { describe, expect, it, vi } from 'vitest';
import { liveGame, nflGames, SUNDAY_KICKOFF } from '../../test/support/season.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger, type Logger } from '../log.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import { createInMemoryRepos } from '../repos/memory.js';
import type { StoredGamePlays } from '../repos/reference.js';
import { needsScoringPlays, refreshNflGames, refreshScoringPlays } from './nfl-games.js';

const WEEK1 = nflGames(1);
const PHI = '2026_01_DAL_PHI';
const TARGET = { season: 2026, week: 1, games: WEEK1, live: true };

const play = (id: string, text: string, away: number, home: number): ScoringPlay => ({
  id,
  kind: 'touchdown',
  typeText: 'Rushing Touchdown',
  text,
  period: 1,
  clock: '9:00',
  team: 'PHI',
  awayScore: away,
  homeScore: home
});

/** The week's games (PHI's scored, the rest scoreless), and a summary per ESPN id. */
function setup() {
  const repos = createInMemoryRepos();
  const reference = createInMemoryReferenceStore(repos.players);
  const warn = vi.fn();
  const log: Logger = { ...silentLogger, warn };
  const box: { games: LiveGame[]; plays: Record<string, ScoringPlay[]>; failing: Set<string> } = {
    games: WEEK1.map((g) =>
      liveGame(g.gameId, g.gameId === PHI ? { homeScore: 7, awayScore: 0 } : { homeScore: 0, awayScore: 0 })
    ),
    plays: { [`espn-${PHI}`]: [play('1', 'Saquon Barkley 3 Yd Run (Jake Elliott Kick)', 0, 7)] },
    failing: new Set()
  };
  const getScoringPlays = vi.fn(async (espnId: string) => {
    if (box.failing.has(espnId)) throw new Error('HTTP 503');
    return box.plays[espnId] ?? [];
  });
  const provider = {
    getLiveGames: async () => box.games,
    getScoringPlays
  } as unknown as DataProvider;
  const clock = new FixedClock(new Date(Date.parse(SUNDAY_KICKOFF) + 3_600_000));
  const deps = { reference, events: new InMemoryEventPublisher(), log, provider };
  const stored = async () =>
    (await reference.nflPlays.listWeek(2026, 1)).find((g) => g.espnId === `espn-${PHI}`);
  return { deps, box, getScoringPlays, clock, warn, stored };
}

describe('refreshNflGames: scoring plays (#164)', () => {
  it("reads a game's plays when its score moves, and keeps when each play was first seen", async () => {
    const { deps, box, getScoringPlays, clock, stored } = setup();
    const first = clock.now().toISOString();
    await refreshNflGames(deps, TARGET, clock.now());
    // Only the game with points: the scoreless ones have no plays to read.
    expect(getScoringPlays.mock.calls.map(([id]) => id)).toEqual([`espn-${PHI}`]);
    expect(await stored()).toMatchObject({
      season: 2026,
      week: 1,
      gameKey: PHI,
      homeScore: 7,
      awayScore: 0,
      plays: [{ id: '1', text: 'Saquon Barkley 3 Yd Run (Jake Elliott Kick)', seenAt: first }],
      updatedAt: first
    });

    // Two minutes on, same score: no read.
    clock.advance(120_000);
    box.games = box.games.map((g) => ({ ...g, clock: '6:10' }));
    await refreshNflGames(deps, TARGET, clock.now());
    expect(getScoringPlays).toHaveBeenCalledTimes(1);

    // DAL scores: one read; the old play keeps its first sighting, the new one gets now.
    clock.advance(120_000);
    box.games = box.games.map((g) => (g.gameKey === PHI ? { ...g, awayScore: 3 } : g));
    box.plays[`espn-${PHI}`] = [
      ...(box.plays[`espn-${PHI}`] ?? []),
      { ...play('2', 'Brandon Aubrey 40 Yd Field Goal', 3, 7), kind: 'field_goal', team: 'DAL' }
    ];
    await refreshNflGames(deps, TARGET, clock.now());
    expect(getScoringPlays).toHaveBeenCalledTimes(2);
    expect((await stored())?.plays.map((p) => [p.id, p.seenAt])).toEqual([
      ['1', first],
      ['2', clock.now().toISOString()]
    ]);
  });

  it('reads again while the summary trails the scoreboard, then stops', async () => {
    const { deps, box, getScoringPlays, clock, stored } = setup();
    box.plays[`espn-${PHI}`] = [];
    await refreshNflGames(deps, TARGET, clock.now());
    expect((await stored())?.plays).toEqual([]);

    // The scoreboard already has 7-0, ESPN's summary lags: a play arrives on the next read.
    clock.advance(120_000);
    box.plays[`espn-${PHI}`] = [play('1', 'Saquon Barkley 3 Yd Run (Jake Elliott Kick)', 0, 7)];
    await refreshNflGames(deps, TARGET, clock.now());
    expect(getScoringPlays).toHaveBeenCalledTimes(2);
    expect((await stored())?.plays[0]?.seenAt).toBe(clock.now().toISOString());

    clock.advance(120_000);
    await refreshNflGames(deps, TARGET, clock.now());
    expect(getScoringPlays).toHaveBeenCalledTimes(2);
  });

  it('never fails the NFL games when a summary fails, and tries that game again next poll', async () => {
    const { deps, box, getScoringPlays, clock, warn, stored } = setup();
    box.failing.add(`espn-${PHI}`);
    expect(await refreshNflGames(deps, TARGET, clock.now())).toBe('changed');
    expect(await stored()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'could not read the scoring plays of a game; trying again next poll',
      expect.objectContaining({ espnId: `espn-${PHI}` })
    );

    clock.advance(120_000);
    box.failing.clear();
    expect(await refreshNflGames(deps, TARGET, clock.now())).toBe('unchanged');
    expect(getScoringPlays).toHaveBeenCalledTimes(2);
    expect((await stored())?.plays).toHaveLength(1);
  });

  it('warns and reads nothing when the stored plays cannot be read, and skips a provider without them', async () => {
    const { deps, getScoringPlays, clock, warn } = setup();
    deps.reference.nflPlays.listWeek = () => Promise.reject(new Error('throttled'));
    expect(await refreshNflGames(deps, TARGET, clock.now())).toBe('changed');
    expect(getScoringPlays).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('could not read the stored scoring plays', expect.anything());

    const bare = { ...deps, provider: { getLiveGames: async () => [] } as unknown as DataProvider };
    expect(await refreshScoringPlays(bare, 2026, 1, [], [liveGame(PHI)], clock.now())).toBe(0);
  });
});

describe('needsScoringPlays', () => {
  const game = liveGame(PHI, { homeScore: 7, awayScore: 3 });
  const stored = (over: Partial<StoredGamePlays> = {}): StoredGamePlays => ({
    season: 2026,
    week: 1,
    espnId: game.espnId,
    gameKey: PHI,
    homeScore: 7,
    awayScore: 3,
    plays: [{ ...play('1', 'x', 3, 7), seenAt: '2026-09-13T18:00:00.000Z' }],
    updatedAt: '2026-09-13T18:00:00.000Z',
    ...over
  });

  it('reads a game with points whose score moved or is not yet covered by its plays', () => {
    expect(
      needsScoringPlays(
        liveGame(PHI, { state: 'pre', homeScore: null, awayScore: null }),
        undefined,
        undefined
      )
    ).toBe(false);
    expect(needsScoringPlays(liveGame(PHI, { homeScore: 0, awayScore: 0 }), undefined, undefined)).toBe(
      false
    );
    expect(needsScoringPlays(game, undefined, stored())).toBe(true);
    expect(needsScoringPlays(game, { ...game, homeScore: 0 }, stored())).toBe(true);
    expect(needsScoringPlays(game, game, undefined)).toBe(true);
    expect(needsScoringPlays(game, game, stored({ homeScore: 0 }))).toBe(true);
    expect(needsScoringPlays(game, game, stored())).toBe(false);
    // The plays stop short of the score: the summary trailed the scoreboard.
    expect(needsScoringPlays(game, game, stored({ plays: [{ ...play('1', 'x', 0, 7), seenAt: 'x' }] }))).toBe(
      true
    );
    // Plays without scores: the stored scoreboard score decides.
    const unscored = { ...play('1', 'x', 0, 0), awayScore: null, homeScore: null, seenAt: 'x' };
    expect(needsScoringPlays(game, game, stored({ plays: [unscored] }))).toBe(false);
    // No plays yet though the game has points: the summary trails.
    expect(needsScoringPlays(game, game, stored({ plays: [] }))).toBe(true);
  });
});
