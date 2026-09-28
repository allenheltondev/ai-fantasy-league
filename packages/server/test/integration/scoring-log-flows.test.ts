import { scoringPreset, sumPoints, yahooDefaultSettings } from '@fantasy/core';
import type { StatLine } from '@fantasy/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestStats } from '../../src/jobs/ingest-stats.js';
import { scoreLiveWeek } from '../../src/jobs/season.js';
import { silentLogger } from '../../src/log.js';
import { registry } from '../../src/operations/index.js';
import { createHarness, type Harness } from '../support/harness.js';
import { nflState, StubProvider } from '../support/jobs.js';
import { as, data, errorCode, type Caller } from '../support/league-client.js';
import { ALICE, BOB, CAROL, seedLeague } from '../support/leagues.js';
import { SEASON, SUNDAY_KICKOFF, seedNflSchedule, seedSeasonLeague } from '../support/season.js';

/**
 * The matchup scoring log (#162) end to end over HTTP (dynalite): the live stats job stores each
 * change once for every league, get_scoring_log scores it with each league's rules, and the live
 * push carries the new entries. team-1 is Alice's, team-2 an agent seat, team-3 Bob's.
 */

interface Entry {
  id: string;
  at: string;
  kind: 'live' | 'correction';
  teamId: string;
  slot: string;
  starter: boolean;
  player: { id: string; name: string };
  changes: { stat: string; delta: number }[];
  summary: string;
  points: number;
  touchdown: boolean;
}
interface LogPage {
  week: number;
  teamId: string;
  matchupId: string | null;
  entries: Entry[];
  nextCursor: string | null;
}
interface MatchupBody {
  matchup: { id: string; home: { teamId: string }; away: { teamId: string } };
  lineups: Record<
    'home' | 'away',
    { teamId: string; players: { player: { id: string }; slot: string; points: number | null }[] }
  >;
}

let h: Harness;
let alice: Caller;
let bob: Caller;
let provider: StubProvider;
let starter: string;
let bench: string;
let opponentStarter: string;

const LOG = '/leagues/lg-log/matchup/scoring-log';
const line = (playerId: string, stats: Record<string, number>): StatLine => ({
  playerId,
  season: SEASON,
  week: 1,
  stats
});
const jobDeps = () => ({
  provider,
  reference: h.services.data.reference,
  repos: h.repos,
  events: h.events,
  directory: h.services.data.players,
  log: silentLogger
});

beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo', registry });
  alice = as(h, ALICE);
  bob = as(h, BOB);
  provider = new StubProvider();
  const reference = h.services.data.reference;
  await seedNflSchedule(reference);
  await reference.nflState.put(
    { ...nflState({ season: SEASON, leagueSeason: SEASON }), updatedAt: '2026-09-01T00:00:00.000Z' },
    null
  );
  await seedSeasonLeague({ repos: h.repos, reference }, { id: 'lg-log', owners: [ALICE, null, BOB] });
  await seedSeasonLeague(
    { repos: h.repos, reference },
    {
      id: 'lg-log-std',
      owners: [ALICE, null, BOB],
      overrides: { settings: { ...yahooDefaultSettings(4), scoring: scoringPreset('standard') } }
    }
  );
  await seedLeague(h.repos, { id: 'lg-log-setup', owners: [ALICE], overrides: { phase: 'setup' } });

  // The opponent starts his first rostered player at QB (team-1's lineup is seeded).
  const opponent = async (leagueId: string) => {
    const m = data<MatchupBody>(await alice.get(`/leagues/${leagueId}/matchup`)).matchup;
    const id = m.home.teamId === 'team-1' ? m.away.teamId : m.home.teamId;
    const team = await h.repos.teams.get(leagueId, id);
    return team!;
  };
  for (const leagueId of ['lg-log', 'lg-log-std']) {
    const team = await opponent(leagueId);
    const roster = team.roster.length > 0 ? team.roster : ['fx-lamar'];
    if (team.roster.length === 0) await h.repos.teams.update({ ...team, roster });
    await h.repos.lineups.put([
      {
        leagueId,
        teamId: team.id,
        week: 1,
        entries: roster.map((playerId, i) => ({ playerId, slot: i === 0 ? 'QB' : 'BN' })),
        updatedAt: '2026-09-10T00:00:00.000Z',
        updatedBy: 'user#seed'
      }
    ]);
  }

  const matchup = data<MatchupBody>(await alice.get('/leagues/lg-log/matchup'));
  const mine = matchup.lineups.home.teamId === 'team-1' ? matchup.lineups.home : matchup.lineups.away;
  const theirs = mine === matchup.lineups.home ? matchup.lineups.away : matchup.lineups.home;
  const isStarter = (slot: string) => slot !== 'BN' && slot !== 'IR';
  starter = mine.players.find((p) => isStarter(p.slot) && p.player.id === 'fx-cmc')!.player.id;
  bench = mine.players.find((p) => !isStarter(p.slot))!.player.id;
  opponentStarter = theirs.players.find((p) => isStarter(p.slot))!.player.id;
});
afterAll(() => h.close());

describe('the scoring log', () => {
  it('records each live change once and scores it per league, newest first', async () => {
    h.clock.set(new Date(Date.parse(SUNDAY_KICKOFF) + 30 * 60_000));
    provider.stats = [
      line(starter, { rush_att: 3, rush_yd: 12, off_snp: 10 }),
      line(bench, { rec: 1, rec_yd: 9 }),
      line(opponentStarter, { rec: 2, rec_yd: 25, pass_yd: 40 })
    ];
    expect(await ingestStats(jobDeps(), h.clock)).toMatchObject({ changed: 3, events: 3 });

    h.clock.advance(120_000);
    provider.stats = [
      line(starter, { rush_att: 5, rush_yd: 30, rush_td: 1, off_snp: 14 }),
      line(bench, { rec: 1, rec_yd: 9 }),
      // Only the snaps moved: stored, but not an event.
      line(opponentStarter, { rec: 2, rec_yd: 25, pass_yd: 40, off_snp: 30 })
    ];
    expect(await ingestStats(jobDeps(), h.clock)).toMatchObject({ changed: 2, events: 1 });

    const log = data<LogPage>(await alice.get(LOG));
    expect(log).toMatchObject({ week: 1, teamId: 'team-1', nextCursor: null });
    expect(log.matchupId).toMatch(/^W01-/);
    expect(log.entries.map((e) => [e.player.id, e.points])).toEqual([
      [starter, 7.8],
      // Same time: by player id, descending.
      [opponentStarter, 5.1],
      [starter, 1.2]
    ]);
    expect(log.entries[0]).toMatchObject({
      kind: 'live',
      teamId: 'team-1',
      starter: true,
      touchdown: true,
      summary: '+18 rush yds, +1 rush TD',
      at: '2026-09-13T17:32:00.000Z'
    });
    expect(log.entries[1]).toMatchObject({ summary: '+40 pass yds, +2 rec, +25 rec yds', touchdown: false });

    // The same events under standard scoring: receptions are worth nothing there.
    const std = data<LogPage>(await alice.get('/leagues/lg-log-std/matchup/scoring-log'));
    expect(std.entries.find((e) => e.player.id === opponentStarter)).toMatchObject({
      points: 4.1,
      summary: '+40 pass yds, +25 rec yds'
    });
  });

  it("adds up to each player's points in get_matchup, and the bench on request", async () => {
    const matchup = data<MatchupBody>(await alice.get('/leagues/lg-log/matchup'));
    const players = [...matchup.lineups.home.players, ...matchup.lineups.away.players];
    const log = data<LogPage>(await alice.get(`${LOG}?includeBench=true`));
    for (const id of [starter, bench, opponentStarter]) {
      const total = sumPoints(log.entries.filter((e) => e.player.id === id).map((e) => e.points));
      expect(total, id).toBe(players.find((p) => p.player.id === id)?.points);
    }
    expect(log.entries.find((e) => e.player.id === bench)).toMatchObject({ starter: false, slot: 'BN' });
    const starters = data<LogPage>(await alice.get(LOG));
    expect(starters.entries.some((e) => e.player.id === bench)).toBe(false);
  });

  it('shows stat corrections from the official final', async () => {
    const reference = h.services.data.reference;
    const [stored] = (await reference.stats.getWeek(SEASON, 1)).filter((l) => l.playerId === starter);
    const at = '2026-09-17T15:00:00.000Z';
    await reference.scoringLog.put([
      {
        season: SEASON,
        week: 1,
        playerId: starter,
        at,
        kind: 'correction',
        stats: { ...stored!.stats, rush_yd: 28 }
      }
    ]);
    const log = data<LogPage>(await alice.get(LOG));
    expect(log.entries[0]).toMatchObject({ kind: 'correction', points: -0.2, summary: '-2 rush yds', at });
  });

  it('pages newest first with a cursor', async () => {
    const first = data<LogPage>(await alice.get(`${LOG}?limit=2`));
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = data<LogPage>(await alice.get(`${LOG}?limit=2&cursor=${first.nextCursor}`));
    expect(second.entries.map((e) => e.id)).toEqual(
      data<LogPage>(await alice.get(LOG))
        .entries.slice(2, 4)
        .map((e) => e.id)
    );
    expect(second.nextCursor).toBeNull();
    const bad = await alice.get(`${LOG}?cursor=bm9wZQ`);
    expect(bad.status).toBe(400);
    expect(errorCode(bad)).toBe('INVALID_INPUT');
  });

  it('is the same log from the other side, for members only, and empty without a matchup', async () => {
    const own = data<LogPage>(await alice.get(LOG));
    const opponent = own.entries.find((e) => e.teamId !== 'team-1')!.teamId;
    const theirs = data<LogPage>(await alice.get(`${LOG}?teamId=${opponent}`));
    expect(theirs.entries.map((e) => e.id)).toEqual(own.entries.map((e) => e.id));
    expect(data<LogPage>(await bob.get(`${LOG}?teamId=team-1`)).entries).toHaveLength(own.entries.length);

    const outsider = await as(h, CAROL).get(LOG);
    expect(outsider.status).toBe(403);

    const setup = await alice.get('/leagues/lg-log-setup/matchup/scoring-log');
    expect(data<LogPage>(setup)).toMatchObject({ matchupId: null, entries: [], nextCursor: null });
    expect((setup.body as { warnings: { code: string }[] }).warnings[0]?.code).toBe('NO_SCHEDULE_YET');
    expect(errorCode(await alice.get(`${LOG}?week=18`))).toBe('INVALID_INPUT');
  });

  it('rides on the live Scores Updated push', async () => {
    h.clock.advance(120_000);
    provider.stats = [line(opponentStarter, { rec: 3, rec_yd: 41, pass_yd: 40, off_snp: 31 })];
    await ingestStats(jobDeps(), h.clock);
    const before = h.events.events.length;
    await scoreLiveWeek(jobDeps(), h.clock);
    const pushed = h.events.events
      .slice(before)
      .find((e) => e.detailType === 'Scores Updated' && e.detail.leagueId === 'lg-log');
    const logs = (pushed?.detail as { scoringLog?: { matchupId: string; entries: Entry[] }[] }).scoringLog;
    const own = data<LogPage>(await alice.get(LOG));
    const forMatchup = logs?.find((l) => l.matchupId === own.matchupId);
    const pushedEntry = forMatchup?.entries.find((e) => e.player.id === opponentStarter);
    expect(pushedEntry).toMatchObject({
      player: { id: opponentStarter },
      summary: '+1 rec, +16 rec yds',
      points: 2.1
    });
    // Recent entries only: the older ones are already on the page.
    expect(forMatchup?.entries.every((e) => e.at >= '2026-09-13T17:30:00.000Z')).toBe(true);
    expect(pushedEntry?.id).toBe(own.entries.find((e) => e.player.id === opponentStarter)?.id);
  });

  it('pushes the scores without the log when the log cannot be read', async () => {
    const log = h.services.data.reference.scoringLog;
    const listPlayers = log.listPlayers.bind(log);
    log.listPlayers = () => Promise.reject(new Error('throttled'));
    try {
      h.clock.advance(120_000);
      provider.stats = [line(opponentStarter, { rec: 4, rec_yd: 50, pass_yd: 40, off_snp: 35 })];
      await ingestStats(jobDeps(), h.clock);
      const before = h.events.events.length;
      expect(await scoreLiveWeek(jobDeps(), h.clock)).toMatchObject({ status: 'ok', failed: 0 });
      const pushed = h.events.events
        .slice(before)
        .find((e) => e.detailType === 'Scores Updated' && e.detail.leagueId === 'lg-log');
      expect(pushed?.detail).toMatchObject({ leagueId: 'lg-log' });
      expect(pushed?.detail).not.toHaveProperty('scoringLog');
    } finally {
      log.listPlayers = listPlayers;
    }
  });
});
