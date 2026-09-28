import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixtureJson, fixtureRoute, json, mockFetch, text, type Route } from '../../test/helpers.js';
import { HttpStatusError, SchemaDriftError } from '../errors.js';
import { NflverseClient } from '../nflverse/client.js';
import { LiveDataProvider } from '../providers/live.js';
import { SleeperClient } from '../sleeper/client.js';
import type { ScheduledGame } from '../types.js';
import { EspnClient } from './client.js';
import { espnTeam, normalizeScoreboard, yardsToGoal } from './normalize.js';
import { espnScoreboardSchema } from './schemas.js';

const asOf = new Date('2026-10-04T18:30:00.000Z');
const FIXTURE = 'espn/scoreboard_regular_2026_4.json';
const board = () => espnScoreboardSchema.parse(fixtureJson(FIXTURE));

const game = (gameId: string, awayTeam: string, homeTeam: string): ScheduledGame => ({
  gameId,
  season: 2026,
  seasonType: 'regular',
  week: 4,
  kickoff: '2026-10-04T17:00:00.000Z',
  homeTeam,
  awayTeam,
  status: 'scheduled'
});
const SCHEDULE = [
  game('2026_04_DAL_PHI', 'DAL', 'PHI'),
  game('2026_04_WAS_NYG', 'WAS', 'NYG'),
  // Listed the other way round (a neutral site): still matched.
  game('2026_04_BUF_MIA', 'BUF', 'MIA'),
  game('2026_04_KC_JAX', 'KC', 'JAX')
];

const espnRoute: Route = (url) =>
  url.hostname === 'site.api.espn.com' ? json(fixtureJson(FIXTURE)) : text('not found', 404);

describe('EspnClient', () => {
  it('reads one week of the scoreboard', async () => {
    const m = mockFetch(espnRoute);
    const espn = new EspnClient({ fetch: m.fetch });
    const scoreboard = await espn.scoreboard(2026, 4);
    expect(m.calls).toEqual([
      'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=4'
    ]);
    expect(scoreboard.events).toHaveLength(5);
    await espn.scoreboard(2026, 1, 'post');
    expect(m.calls[1]).toContain('seasontype=3&week=1');
  });

  it('retries once, then fails with the status', async () => {
    const m = mockFetch(() => text('busy', 503));
    const espn = new EspnClient({ fetch: m.fetch, sleep: async () => undefined, random: () => 0 });
    await expect(espn.scoreboard(2026, 4)).rejects.toBeInstanceOf(HttpStatusError);
    expect(m.calls).toHaveLength(2);
  });

  it('flags a payload without events as drift and rejects a bad week', async () => {
    const m = mockFetch(() => json({ sports: [] }));
    const espn = new EspnClient({
      fetch: m.fetch,
      scoreboardUrl: 'https://proxy.test/sb',
      retry: { maxRetries: 0 },
      timeoutMs: 100
    });
    await expect(espn.scoreboard(2026, 4)).rejects.toBeInstanceOf(SchemaDriftError);
    expect(m.calls[0]).toMatch(/^https:\/\/proxy\.test\/sb\?/);
    await expect(espn.scoreboard(2026, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(espn.scoreboard(1999, 1)).rejects.toBeInstanceOf(RangeError);
    await expect(espn.scoreboard(2026, 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('normalizeScoreboard (recorded fixture)', () => {
  const games = normalizeScoreboard(board(), { games: SCHEDULE, asOf });
  const byHome = (home: string) => games.find((g) => g.homeTeam === home);

  it('reads a red-zone drive', () => {
    expect(byHome('PHI')).toEqual({
      gameKey: '2026_04_DAL_PHI',
      espnId: '401772901',
      homeTeam: 'PHI',
      awayTeam: 'DAL',
      homeScore: 14,
      awayScore: 10,
      kickoff: '2026-10-04T17:00:00.000Z',
      state: 'in',
      status: '8:32 - 2nd',
      period: 2,
      clock: '8:32',
      possessionTeam: 'PHI',
      isRedZone: true,
      downDistance: '2nd & 4 at DAL 7',
      fieldPosition: 'DAL 7',
      yardsToGoal: 7,
      updatedAt: asOf.toISOString()
    });
  });

  it("reads a drive outside the red zone and maps ESPN's WSH to WAS", () => {
    expect(byHome('NYG')).toMatchObject({
      gameKey: '2026_04_WAS_NYG',
      awayTeam: 'WAS',
      possessionTeam: 'WAS',
      isRedZone: false,
      downDistance: '1st & 10 at WSH 35',
      yardsToGoal: 65
    });
  });

  it('has no possession between plays when ESPN leaves it out', () => {
    expect(byHome('BUF')).toMatchObject({
      gameKey: '2026_04_BUF_MIA',
      state: 'in',
      period: 4,
      clock: '0:45',
      possessionTeam: null,
      isRedZone: false,
      downDistance: null,
      fieldPosition: null,
      yardsToGoal: null
    });
  });

  it('reads pregame and final games without a situation', () => {
    expect(byHome('SF')).toMatchObject({
      gameKey: null,
      awayTeam: 'LAR',
      state: 'pre',
      homeScore: null,
      awayScore: null,
      period: null,
      clock: null,
      status: '10/4 - 4:25 PM EDT',
      kickoff: '2026-10-04T20:25:00.000Z',
      possessionTeam: null
    });
    expect(byHome('JAX')).toMatchObject({
      gameKey: '2026_04_KC_JAX',
      state: 'post',
      status: 'Final',
      homeScore: 24,
      awayScore: 27,
      clock: null,
      isRedZone: false
    });
  });
});

describe('normalizeScoreboard (tolerance)', () => {
  const competitor = (id: string, abbreviation: string, homeAway: 'home' | 'away', score?: unknown) => ({
    id,
    homeAway,
    team: { id, abbreviation },
    ...(score === undefined ? {} : { score })
  });
  const event = (competition: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: 'e1',
    ...extra,
    competitions: [
      {
        status: { type: { state: 'in' } },
        competitors: [competitor('1', 'PHI', 'home', '7'), competitor('2', 'DAL', 'away', 3)],
        ...competition
      }
    ]
  });
  const one = (e: unknown) => normalizeScoreboard({ events: [e] }, { games: [], asOf })[0];

  it('builds down and distance from the numbers when the text is missing', () => {
    expect(
      one(
        event({
          situation: { possession: '2', down: 3, distance: 8, possessionText: 'PHI 12', isRedZone: true }
        })
      )
    ).toMatchObject({
      possessionTeam: 'DAL',
      isRedZone: true,
      downDistance: '3rd & 8 at PHI 12',
      yardsToGoal: 12,
      homeScore: 7,
      awayScore: 3,
      kickoff: null,
      status: null,
      period: null
    });
    expect(one(event({ situation: { possession: '1', down: 1, distance: 10 } }))).toMatchObject({
      downDistance: '1st & 10',
      fieldPosition: null,
      yardsToGoal: null
    });
    expect(one(event({ situation: { possession: '1', down: 5, distance: 1 } }))?.downDistance).toBeNull();
    expect(
      one(event({ situation: { possession: '1', downDistanceText: '4th & 1 at PHI 40' } }))
    ).toMatchObject({ fieldPosition: 'PHI 40', yardsToGoal: 60 });
  });

  it('ignores a possession it cannot place and an unknown team', () => {
    expect(one(event({ situation: { possession: '99', isRedZone: true } }))).toMatchObject({
      possessionTeam: null,
      isRedZone: false
    });
    const unknown = one(
      event({
        competitors: [competitor('1', 'XYZ', 'home', 'n/a'), competitor('2', 'DAL', 'away', '')],
        situation: { possession: '1', isRedZone: true }
      })
    );
    expect(unknown).toMatchObject({ homeTeam: null, possessionTeam: null, homeScore: null, awayScore: null });
    const noHome = one(
      event({ competitors: [competitor('1', 'PHI', 'away'), competitor('2', 'DAL', 'away')] })
    );
    expect(noHome).toMatchObject({ homeTeam: null, awayTeam: 'PHI', gameKey: null, homeScore: null });
  });

  it('skips a malformed event, and calls it drift only when none parse', () => {
    const good = event({});
    const games = normalizeScoreboard({ events: [{ id: 'bad' }, good] }, { games: [], asOf });
    expect(games).toHaveLength(1);
    expect(() => normalizeScoreboard({ events: [{ id: 'bad' }] }, { games: [], asOf })).toThrow(
      /events\.0\.competitions/
    );
    expect(normalizeScoreboard({ events: [] }, { games: [], asOf })).toEqual([]);
  });

  it('never throws on a well-formed game, whatever else ESPN adds or leaves out', () => {
    const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
    const situation = fc.record(
      {
        possession: optional(fc.oneof(fc.constant('1'), fc.constant('2'), fc.string())),
        isRedZone: optional(fc.oneof(fc.boolean(), fc.constant(null))),
        down: optional(fc.oneof(fc.integer({ min: -1, max: 6 }), fc.constant(null))),
        distance: optional(fc.integer({ min: 0, max: 99 })),
        downDistanceText: optional(fc.string()),
        possessionText: optional(fc.oneof(fc.string(), fc.constantFrom('DAL 7', 'PHI 50', '50', 'XX 99'))),
        junk: optional(fc.anything())
      },
      { requiredKeys: [] }
    );
    fc.assert(
      fc.property(
        fc.constantFrom('pre', 'in', 'post'),
        fc.option(situation, { nil: undefined }),
        fc.dictionary(
          fc.string().filter((k) => !['id', 'competitions'].includes(k)),
          fc.anything()
        ),
        (state, sit, extra) => {
          const e = event(
            { status: { type: { state } }, ...(sit === undefined ? {} : { situation: sit }) },
            extra
          );
          const [g] = normalizeScoreboard({ events: [e] }, { games: [], asOf });
          expect(g?.state).toBe(state);
          if (state !== 'in' || sit === undefined) {
            expect(g?.isRedZone).toBe(false);
            expect(g?.possessionTeam).toBeNull();
          }
          if (g?.isRedZone) expect(sit?.isRedZone).toBe(true);
          if (g?.yardsToGoal != null) {
            expect(g.yardsToGoal).toBeGreaterThanOrEqual(0);
            expect(g.yardsToGoal).toBeLessThanOrEqual(100);
          }
        }
      )
    );
  });
});

describe('team codes and field position', () => {
  it("maps ESPN's codes to ours", () => {
    expect(espnTeam('WSH')).toBe('WAS');
    expect(espnTeam('JAX')).toBe('JAX');
    expect(espnTeam('LAR')).toBe('LAR');
    expect(espnTeam('LA')).toBe('LAR');
    expect(espnTeam('AFC')).toBeNull();
    expect(espnTeam('')).toBeNull();
  });

  it('measures yards to the goal from the offense', () => {
    expect(yardsToGoal('DAL 7', 'PHI')).toBe(7);
    expect(yardsToGoal('PHI 7', 'PHI')).toBe(93);
    expect(yardsToGoal('WSH 35', 'WAS')).toBe(65);
    expect(yardsToGoal('50', 'PHI')).toBe(50);
    expect(yardsToGoal('40', 'PHI')).toBeNull();
    expect(yardsToGoal('DAL 60', 'PHI')).toBeNull();
    expect(yardsToGoal('midfield', 'PHI')).toBeNull();
    expect(yardsToGoal(null, 'PHI')).toBeNull();
  });
});

describe('LiveDataProvider.getLiveGames', () => {
  const tinyBoard = {
    events: [
      {
        id: 'e1',
        competitions: [
          {
            status: { type: { state: 'post', shortDetail: 'Final' } },
            competitors: [
              { homeAway: 'home', team: { id: '25', abbreviation: 'SF' }, score: '26' },
              { homeAway: 'away', team: { id: '30', abbreviation: 'JAX' }, score: '21' }
            ]
          }
        ]
      }
    ]
  };
  function provider(route: Route, espn = true) {
    const m = mockFetch(route);
    return {
      calls: m.calls,
      provider: new LiveDataProvider({
        sleeper: new SleeperClient({
          clock: { now: () => asOf },
          fetch: m.fetch,
          limiter: { acquire: async () => undefined }
        }),
        nflverse: new NflverseClient({ fetch: m.fetch, sleep: async () => undefined }),
        ...(espn && { espn: new EspnClient({ fetch: m.fetch }) })
      })
    };
  }

  it('matches the scoreboard to the schedule it is given', async () => {
    const { provider: live, calls } = provider(espnRoute);
    const games = await live.getLiveGames(2026, 4, asOf, SCHEDULE);
    expect(games.filter((g) => g.gameKey !== null)).toHaveLength(4);
    expect(calls.every((c) => c.includes('espn.com'))).toBe(true);
  });

  it("reads the week's regular-season games from nflverse when not given them", async () => {
    const { provider: live } = provider((url, call) =>
      url.hostname === 'site.api.espn.com' ? json(tinyBoard) : fixtureRoute(url, call)
    );
    expect(await live.getLiveGames(2025, 4, asOf)).toMatchObject([
      { gameKey: '2025_04_JAX_SF', homeScore: 26, awayScore: 21, state: 'post' }
    ]);
  });

  it('has no live games without an ESPN client', async () => {
    const { provider: live, calls } = provider(espnRoute, false);
    expect(await live.getLiveGames(2026, 4, asOf, SCHEDULE)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
