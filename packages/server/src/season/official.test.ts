import { FixedClock } from '@fantasy/core';
import type { IdCrosswalk, StatLine } from '@fantasy/data';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps, sourcePlayer, StubProvider } from '../../test/support/jobs.js';
import { ALICE } from '../../test/support/leagues.js';
import { MONDAY_KICKOFF, SEASON, seedNflSchedule, seedSeasonLeague } from '../../test/support/season.js';
import { officialFinal, OFFICIAL_AFTER_MS } from '../jobs/season.js';
import type { League, Matchup } from '../repos/types.js';
import { finalizeOfficialWeek, OFFICIAL_CLAIM_STALE_MS } from './official.js';
import { recordStandings } from './scoring.js';

const WEEK_MS = 7 * 24 * 3_600_000;
/** When week `week` is past its stat-correction window. */
const officialTime = (week: number) =>
  new Date(Date.parse(MONDAY_KICKOFF) + (week - 1) * WEEK_MS + 5 * 3_600_000 + OFFICIAL_AFTER_MS);

class OfficialProvider extends StubProvider {
  crosswalk: IdCrosswalk | undefined;
  async getOfficialWeekStats(season: number, week: number, _asOf: Date, crosswalk?: IdCrosswalk) {
    this.crosswalk = crosswalk;
    return this.getWeekStats(season, week);
  }
}

const cmc = (rushYards: number): StatLine & { updatedAt: string } => ({
  playerId: 'fx-cmc',
  season: SEASON,
  week: 4,
  stats: { rush_yd: rushYards },
  updatedAt: '2026-10-06T06:00:00.000Z'
});

/**
 * A league in week 5 whose week 4 is provisionally final: team-1 (Alice) scored 10 with fx-cmc's
 * 100 rushing yards and beat its opponent 10-8.
 */
async function setup(
  options: { provider?: StubProvider; badgeChest?: boolean; officialWeeks?: number[] } = {}
) {
  const provider = options.provider ?? new StubProvider();
  const deps = { ...createTestJobDeps({ provider }), badgeChest: options.badgeChest ?? false };
  await seedNflSchedule(deps.reference);
  // Their NFL teams play every week, so both are locked (and frozen in the lineup) once it ends.
  await deps.repos.players.putMany([
    fakePlayer(),
    { ...fakePlayer(), id: 'fx-opp', name: 'Opp', team: 'KC' }
  ]);
  await seedSeasonLeague(deps, { id: 'lg-off', owners: [ALICE], overrides: { week: 5 } });
  await deps.repos.lineups.put([
    {
      leagueId: 'lg-off',
      teamId: 'team-1',
      week: 4,
      entries: [
        { playerId: 'fx-cmc', slot: 'RB' },
        { playerId: 'fx-bijan', slot: 'BN' }
      ],
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: 'user#alice'
    }
  ]);
  // Waivers dropped fx-cmc after the week: the official score still counts him.
  const team1 = (await deps.repos.teams.get('lg-off', 'team-1'))!;
  await deps.repos.teams.update({ ...team1, roster: team1.roster.filter((id) => id !== 'fx-cmc') });
  await deps.reference.stats.putLines([cmc(100)]);
  const all = await deps.repos.schedule.listMatchups('lg-off');
  const final = all
    .filter((m) => m.week <= 4)
    .map((m): Matchup => {
      const team1Home = m.homeTeamId === 'team-1';
      const team1Away = m.awayTeamId === 'team-1';
      return {
        ...m,
        status: 'final',
        homeScore: m.week === 4 ? (team1Home ? 10 : team1Away ? 8 : 0) : 100,
        awayScore: m.week === 4 ? (team1Away ? 10 : team1Home ? 8 : 0) : 90
      };
    });
  await deps.repos.schedule.putMatchups(final);
  const league = (await deps.repos.leagues.get('lg-off')) as League;
  for (let w = 1; w <= 4; w++) await recordStandings(deps, league, w, new Date('2026-10-06T06:00:00.000Z'));
  const game = final.find((m) => m.week === 4 && (m.homeTeamId === 'team-1' || m.awayTeamId === 'team-1'))!;
  const opponent = game.homeTeamId === 'team-1' ? game.awayTeamId : game.homeTeamId;
  await deps.repos.lineups.put([
    {
      leagueId: 'lg-off',
      teamId: opponent,
      week: 4,
      entries: [{ playerId: 'fx-opp', slot: 'RB' }],
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: 'system'
    }
  ]);
  await deps.reference.stats.putLines([{ ...cmc(80), playerId: 'fx-opp' }]);
  // Weeks 1-3 were made official on time, unless a test says otherwise.
  for (const week of options.officialWeeks ?? [1, 2, 3]) await markOfficial(deps, week);
  return { deps, league, provider, game, opponent };
}

async function markOfficial(deps: ReturnType<typeof createTestJobDeps>, week: number) {
  const record = {
    leagueId: 'lg-off',
    week,
    status: 'complete' as const,
    startedAt: '2026-10-01T00:00:00.000Z',
    completedAt: '2026-10-01T00:00:00.000Z',
    provisional: [],
    corrections: 0,
    flipped: 0
  };
  await deps.repos.history.completeOfficialWeek(record);
}

const types = (events: { detailType: string }[]) => events.map((e) => e.detailType);

describe('finalizeOfficialWeek', () => {
  it('confirms an uncorrected week once, from the lineup it was played with', async () => {
    const { deps, league } = await setup();
    const at = officialTime(4);
    expect(await finalizeOfficialWeek(deps, league, 4, at)).toEqual({
      leagueId: 'lg-off',
      week: 4,
      status: 'official',
      corrections: 0,
      flipped: 0
    });
    const official = deps.events.events.find((e) => e.detailType === 'Week Official Final');
    expect(official?.detail).toMatchObject({
      week: 4,
      corrections: 0,
      recap: 'No stat corrections changed a score.'
    });
    expect(types(deps.events.events)).not.toContain('Stat Correction Applied');
    // The week's top score is an achievement, announced once.
    expect(deps.events.events.find((e) => e.detailType === 'Achievement Earned')?.detail).toMatchObject({
      teamId: 'team-1',
      achievementId: 'weekly-high-score'
    });
    expect(await finalizeOfficialWeek(deps, league, 4, at)).toMatchObject({ reason: 'already_official' });
    expect(await finalizeOfficialWeek(deps, league, 5, at)).toMatchObject({ reason: 'week_not_final' });
  });

  it('applies a correction that flips a result: events, standings, and the badge chest', async () => {
    const { deps, league, opponent } = await setup({ badgeChest: true });
    const winsBefore =
      (await deps.repos.schedule.latestStandings('lg-off'))?.rows.find((r) => r.teamId === opponent)?.wins ??
      0;
    await deps.reference.stats.putLines([cmc(50)]); // 10 points become 5: the opponent's 8 now wins.
    const outcome = await finalizeOfficialWeek(deps, league, 4, officialTime(4));
    expect(outcome).toMatchObject({ status: 'official', corrections: 1, flipped: 1 });
    const correction = deps.events.events.find((e) => e.detailType === 'Stat Correction Applied');
    expect(correction?.detail).toMatchObject({
      week: 4,
      teamId: 'team-1',
      oldScore: 10,
      newScore: 5,
      resultFlipped: true,
      winnerTeamId: opponent,
      loserTeamId: 'team-1',
      winnerScore: 8,
      loserScore: 5
    });
    const standings = await deps.repos.schedule.latestStandings('lg-off');
    expect(standings?.rows.find((r) => r.teamId === opponent)?.wins).toBe(winsBefore + 1);
    // The opponent is an agent seat: no badge chest activity; Alice's team-1 earned nothing this week.
    const activity = deps.events.events.filter((e) => e.detailType === 'Track Activity');
    expect(activity).toEqual([]);
    expect((await deps.repos.history.listAchievements('lg-off')).map((a) => a.teamId)).toEqual([opponent]);
  });

  it('reports badge chest activity for a human owner, and takes over a crashed run', async () => {
    const { deps, league } = await setup({ badgeChest: true });
    const at = officialTime(4);
    const stale = new Date(at.getTime() - OFFICIAL_CLAIM_STALE_MS - 1000);
    const claimed = await deps.repos.history.beginOfficialWeek(
      {
        leagueId: 'lg-off',
        week: 4,
        status: 'running',
        startedAt: stale.toISOString(),
        completedAt: null,
        provisional: [],
        corrections: 0,
        flipped: 0
      },
      stale.toISOString()
    );
    expect(claimed).not.toBeNull();
    // A fresh run cannot take a claim that is not stale yet.
    expect(await finalizeOfficialWeek(deps, league, 4, stale)).toMatchObject({ reason: 'already_official' });
    expect(await finalizeOfficialWeek(deps, league, 4, at)).toMatchObject({ status: 'official' });
    expect(deps.events.events.find((e) => e.detailType === 'Track Activity')?.detail).toEqual({
      id: 'fantasy#lg-off#weekly-high-score#2026#W04#team-1',
      userId: ALICE.sub,
      action: 'fantasy.week.high_score',
      service: 'fantasy',
      value: 'lg-off'
    });
  });

  it('keeps the week open when awarding achievements fails, so a retry awards them (#123)', async () => {
    const { deps, league } = await setup();
    const at = officialTime(4);
    const history = deps.repos.history;
    const addAchievements = history.addAchievements.bind(history);
    history.addAchievements = () => Promise.reject(new Error('throttled'));
    await expect(finalizeOfficialWeek(deps, league, 4, at)).rejects.toThrow('throttled');
    expect((await history.getOfficialWeek('lg-off', 4))?.status).toBe('running');
    expect(await history.listAchievements('lg-off')).toEqual([]);

    history.addAchievements = addAchievements;
    const later = new Date(at.getTime() + OFFICIAL_CLAIM_STALE_MS + 1000);
    expect(await finalizeOfficialWeek(deps, league, 4, later)).toMatchObject({ status: 'official' });
    expect((await history.getOfficialWeek('lg-off', 4))?.status).toBe('complete');
    expect((await history.listAchievements('lg-off')).map((a) => a.achievementId)).toContain(
      'weekly-high-score'
    );
  });
});

describe('officialFinal job', () => {
  it('waits for the correction window, re-pulls the week once, and finalizes each league', async () => {
    const provider = new OfficialProvider();
    const { deps } = await setup({ provider });
    await deps.reference.playerSync.upsert([
      {
        player: fakePlayer(),
        source: sourcePlayer({ id: 'fx-cmc', gsisId: '00-001' })
      }
    ]);
    provider.stats = [{ ...cmc(150) }];
    const early = new FixedClock(new Date(officialTime(4).getTime() - 3_600_000));
    expect(await officialFinal(deps, early)).toMatchObject({ status: 'skipped', reason: 'nothing_due' });

    const result = await officialFinal(deps, new FixedClock(officialTime(4)));
    expect(result).toMatchObject({
      status: 'ok',
      leagues: 1,
      statsChanged: 1,
      corrections: 1,
      official: 1,
      failed: 0
    });
    expect(provider.crosswalk?.toSleeper('00-001')).toBe('fx-cmc');
    expect((await deps.reference.stats.getWeek(SEASON, 4))[0]?.stats.rush_yd).toBe(150);
    // The correction is a scoring log entry (#162).
    expect(await deps.reference.scoringLog.listPlayers(SEASON, 4, ['fx-cmc'])).toEqual([
      expect.objectContaining({
        kind: 'correction',
        at: officialTime(4).toISOString(),
        stats: cmc(150).stats
      })
    ]);
    expect(await officialFinal(deps, new FixedClock(officialTime(4)))).toMatchObject({
      reason: 'nothing_due'
    });
  });

  it('looks at played weeks of in-season leagues and recent complete leagues, never void weeks', async () => {
    const deps = createTestJobDeps();
    await seedNflSchedule(deps.reference);
    await seedSeasonLeague(deps, { id: 'lg-w1', owners: [ALICE], overrides: { week: 1 } });
    // Drafted into week 5: weeks 1-4 are void, their matchups never scored.
    await seedSeasonLeague(deps, { id: 'lg-void', owners: [ALICE], overrides: { week: 5 } });
    await seedSeasonLeague(deps, {
      id: 'lg-old',
      owners: [ALICE],
      overrides: { phase: 'complete', week: 4, updatedAt: '2026-01-01T00:00:00.000Z' }
    });
    await seedSeasonLeague(deps, {
      id: 'lg-done',
      owners: [ALICE],
      overrides: { phase: 'complete', week: 4, updatedAt: '2026-10-05T00:00:00.000Z' }
    });
    for (const id of ['lg-old', 'lg-done']) {
      const played = (await deps.repos.schedule.listMatchups(id)).filter((m) => m.week <= 4);
      await deps.repos.schedule.putMatchups(
        played.map((m): Matchup => ({ ...m, status: 'final', homeScore: 10, awayScore: 8 }))
      );
    }
    for (const week of [1, 2, 3]) {
      await deps.repos.history.completeOfficialWeek({
        leagueId: 'lg-done',
        week,
        status: 'complete',
        startedAt: '2026-10-01T00:00:00.000Z',
        completedAt: '2026-10-01T00:00:00.000Z',
        provisional: [],
        corrections: 0,
        flipped: 0
      });
    }
    const at = new FixedClock(officialTime(4));
    (deps.provider as StubProvider).stats = [];
    await deps.reference.playerSync.upsert([
      { player: fakePlayer(), source: sourcePlayer({ id: 'fx-cmc', gsisId: undefined }) }
    ]);
    // Only lg-done's week 4: lg-old completed too long ago, and lg-void has no played week.
    expect(await officialFinal(deps, at)).toMatchObject({ status: 'ok', leagues: 1, weeks: 1, official: 1 });
    expect((await deps.repos.history.getOfficialWeek('lg-done', 4))?.status).toBe('complete');
    expect(await deps.repos.history.getOfficialWeek('lg-void', 4)).toBeNull();
  });

  it('backfills an earlier played week that was never made official, oldest first (#123)', async () => {
    const { deps } = await setup({ officialWeeks: [1, 3] });
    (deps.provider as StubProvider).stats = [cmc(100)];
    const result = await officialFinal(deps, new FixedClock(officialTime(4)));
    expect(result).toMatchObject({ status: 'ok', leagues: 1, weeks: 2, official: 2, failed: 0 });
    const finals = deps.events.events.filter((e) => e.detailType === 'Week Official Final');
    expect(finals.map((e) => (e.detail as { week: number }).week)).toEqual([2, 4]);
    expect((await deps.repos.history.getOfficialWeek('lg-off', 2))?.status).toBe('complete');
  });

  it('skips without leagues, falls back to getWeekStats, and fails after trying every week', async () => {
    const empty = createTestJobDeps();
    expect(await officialFinal(empty, new FixedClock(officialTime(4)))).toMatchObject({
      reason: 'no_weeks_to_finalize'
    });
    const { deps } = await setup();
    (deps.provider as StubProvider).stats = [cmc(100)];
    const schedule = deps.repos.schedule;
    const listMatchups = schedule.listMatchups.bind(schedule);
    // Listing the league's weeks works; reading one week's matchups fails.
    const broken = {
      ...deps,
      repos: {
        ...deps.repos,
        schedule: {
          ...schedule,
          listMatchups: async (leagueId: string, week?: number) =>
            week === undefined ? listMatchups(leagueId) : Promise.reject(new Error('down'))
        }
      }
    };
    broken.repos.schedule.latestStandings = schedule.latestStandings.bind(schedule);
    await expect(officialFinal(broken, new FixedClock(officialTime(4)))).rejects.toThrow(
      'officialFinal: 1 failed after the rest finished'
    );
    expect((deps.provider as StubProvider).calls).toContain(`getWeekStats:${SEASON}:4`);
    // A league whose weeks cannot be listed is counted as a failure too.
    const down = {
      ...deps,
      repos: {
        ...deps.repos,
        schedule: { ...schedule, listMatchups: () => Promise.reject(new Error('down')) }
      }
    };
    await expect(officialFinal(down, new FixedClock(officialTime(4)))).rejects.toThrow(
      'officialFinal: 1 failed'
    );
  });
});

function fakePlayer() {
  return {
    id: 'fx-cmc',
    name: 'Christian McCaffrey',
    firstName: 'Christian',
    lastName: 'McCaffrey',
    team: 'SF',
    position: 'RB' as const,
    status: 'active' as const,
    injuryStatus: null,
    aliases: [],
    rank: 1,
    updatedAt: '2026-09-01T00:00:00.000Z'
  };
}
