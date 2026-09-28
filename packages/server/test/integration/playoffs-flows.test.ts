import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryEventPublisher } from '../../src/events/publisher.js';
import { silentLogger } from '../../src/log.js';
import { getLeagueHistory } from '../../src/operations/league/get-league-history.js';
import { getPlayoffBracket } from '../../src/operations/league/get-playoff-bracket.js';
import { registry } from '../../src/operations/index.js';
import type { League } from '../../src/repos/types.js';
import type { TransactionRecord } from '../../src/repos/waivers.js';
import { advanceLeague } from '../../src/season/cycle.js';
import { finalizeOfficialWeek } from '../../src/season/official.js';
import { recordStandings } from '../../src/season/scoring.js';
import { createHarness, type Harness } from '../support/harness.js';
import { as, data, type Caller } from '../support/league-client.js';
import { ALICE, BOB } from '../support/leagues.js';
import { MONDAY_KICKOFF, seedNflSchedule, seedSeasonLeague } from '../support/season.js';

/**
 * Playoffs and history over HTTP: a 4-team league plays its last regular-season week, the
 * playoffs, and completes; get_playoff_bracket and get_league_history show it at each step.
 */

const WEEK_MS = 7 * 24 * 3_600_000;
const afterWeek = (week: number) =>
  new Date(Date.parse(MONDAY_KICKOFF) + (week - 1) * WEEK_MS + 5 * 3_600_000);

let h: Harness;
let alice: Caller;
let bob: Caller;
const events = new InMemoryEventPublisher();
const deps = () => ({ repos: h.repos, reference: h.services.data.reference, events, log: silentLogger });

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  await seedNflSchedule(h.services.data.reference);
  await seedSeasonLeague(deps(), { id: 'lg-po', owners: [ALICE, null, BOB], overrides: { week: 15 } });
  const earlier = (await h.repos.schedule.listMatchups('lg-po')).filter((m) => m.week < 15);
  await h.repos.schedule.putMatchups(
    earlier.map((m) => ({ ...m, homeScore: 100 + m.week, awayScore: 90, status: 'final' as const }))
  );
  // This league reseeds after each round.
  const seeded = await league();
  await h.repos.leagues.update({
    ...seeded,
    settings: { ...seeded.settings, playoffs: { ...seeded.settings.playoffs, reseed: true } }
  });
  await recordStandings(deps(), await league(), 14, afterWeek(14));
});
afterAll(() => h.close());

const league = async () => (await h.repos.leagues.get('lg-po')) as League;
type BracketBody = ReturnType<typeof getPlayoffBracket.output.parse>;
type HistoryBody = ReturnType<typeof getLeagueHistory.output.parse>;

async function bracket(): Promise<BracketBody> {
  const res = await alice.get('/leagues/lg-po/playoffs');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return getPlayoffBracket.output.parse(data(res));
}

describe('playoffs and history over HTTP', () => {
  it('projects the bracket during the regular season', async () => {
    const body = await bracket();
    expect(body).toMatchObject({ status: 'projected', teams: 4, byes: 0, weeks: [16, 17], reseed: true });
    expect(body.seeds).toHaveLength(4);
    expect(body.games.filter((g) => g.round === 1).every((g) => g.home.teamName !== null)).toBe(true);
    expect(body.games.find((g) => g.round === 2)?.home.from).toBe('Reseeded after round 1');
  });

  it('seeds the playoffs, shows live semifinal scores, and crowns a champion', async () => {
    await advanceLeague(deps(), await league(), afterWeek(15));
    const semis = await h.repos.schedule.listMatchups('lg-po', 16);
    await h.repos.schedule.putMatchups(
      semis.map((m) => ({ ...m, homeScore: 88.5, awayScore: 70, status: 'in_progress' as const }))
    );
    const live = await bracket();
    expect(live.status).toBe('in_progress');
    expect(live.games.filter((g) => g.week === 16).map((g) => [g.home.score, g.away.score])).toEqual([
      [88.5, 70],
      [88.5, 70]
    ]);

    // The week's final scores come from the stored stats: none, so every game is a 0-0 tie that
    // the better seed (home) wins.
    await advanceLeague(deps(), await league(), afterWeek(16));
    const [final] = await h.repos.schedule.listMatchups('lg-po', 17);
    await advanceLeague(deps(), await league(), afterWeek(17));
    await finalizeOfficialWeek(deps(), await league(), 17, afterWeek(17));
    const done = await bracket();
    expect(done.status).toBe('complete');
    expect(done.championTeamId).toBe(final!.homeTeamId);
    expect(done.games.find((g) => g.week === 17)?.decidedBySeed).toBe(true);
  });

  it('archives the season with records, head-to-head, achievements, and trades', async () => {
    const trade: TransactionRecord = {
      id: 'txn-trade-1',
      leagueId: 'lg-po',
      at: '2026-10-20T12:00:00.000Z',
      week: 7,
      type: 'trade' as TransactionRecord['type'],
      teamId: 'team-1',
      addPlayerId: 'fx-cmc',
      dropPlayerId: null,
      cost: null,
      claimId: null
    };
    await h.repos.waivers.addTransactions([trade]);
    const res = await bob.get('/leagues/lg-po/history');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body: HistoryBody = getLeagueHistory.output.parse(data(res));
    const [season] = body.seasons;
    expect(season?.championTeamId).toBe((await h.repos.history.getPlayoffs('lg-po'))?.championTeamId);
    expect(season?.finalStandings).toHaveLength(4);
    expect(season?.records.highestScore?.points).toBe(114);
    expect(season?.runnerUpTeamId).not.toBeNull();
    expect(body.current.headToHead.length).toBeGreaterThan(0);
    expect(body.current.records.biggestBlowout?.margin).toBe(24);
    expect(body.achievements.map((a) => [a.achievementId, a.teamId])).toEqual(
      expect.arrayContaining([['league-champion', season?.championTeamId]])
    );
    expect(body.achievements.map((a) => a.achievementId)).toContain('season-high-score');
    // The DynamoDB transaction log does not read trade records until the trades stream adds them.
    expect(Array.isArray(body.trades)).toBe(true);
    expect(events.events.map((e) => e.detailType)).toContain('Season Completed');
  });
});

describe('trade history (in-memory transaction log)', () => {
  it('lists processed trades with player refs', async () => {
    const mem = await createHarness({ registry });
    try {
      const memDeps = { repos: mem.repos, reference: mem.services.data.reference };
      await seedNflSchedule(memDeps.reference);
      await seedSeasonLeague(memDeps, { id: 'lg-tr', owners: [ALICE] });
      const trade = (
        id: string,
        addPlayerId: string | null,
        dropPlayerId: string | null
      ): TransactionRecord => ({
        id,
        leagueId: 'lg-tr',
        at: `2026-10-20T12:00:0${id.length % 10}.000Z`,
        week: 7,
        type: 'trade' as TransactionRecord['type'],
        teamId: 'team-1',
        addPlayerId,
        dropPlayerId,
        cost: null,
        claimId: null
      });
      await mem.repos.waivers.addTransactions([
        trade('t1', 'fx-cmc', null),
        trade('t22', null, 'fx-chase'),
        { ...trade('a333', 'fx-kelce', null), type: 'add' }
      ]);
      const res = await as(mem, ALICE).get('/leagues/lg-tr/history');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = getLeagueHistory.output.parse(data(res));
      expect(body.trades.map((t) => [t.id, t.added?.id ?? null, t.dropped?.id ?? null])).toEqual([
        ['t22', null, 'fx-chase'],
        ['t1', 'fx-cmc', null]
      ]);
      expect(body.seasons).toEqual([]);
    } finally {
      await mem.close();
    }
  });
});
