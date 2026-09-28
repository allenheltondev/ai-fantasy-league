import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { ALICE } from '../../test/support/leagues.js';
import { MONDAY_KICKOFF, SEASON, seedNflSchedule, seedSeasonLeague } from '../../test/support/season.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { advanceSeason, scoreLiveWeek } from '../jobs/season.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import type { League } from '../repos/types.js';
import { advanceLeague, scheduleLockWarnings, startLeagueSeason, storedNflState } from './cycle.js';
import { listInSeason, resolveLineup } from './lineups.js';

const WEEK_MS = 7 * 24 * 3_600_000;
/** Five hours after week `week`'s Monday night kickoff: the week is over. */
const afterWeek = (week: number) =>
  new Date(Date.parse(MONDAY_KICKOFF) + (week - 1) * WEEK_MS + 5 * 3_600_000);

async function setup(overrides: Partial<League> = {}, schedule = true) {
  const repos = createInMemoryRepos();
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const deps = { repos, reference, events, log: silentLogger };
  if (schedule) await seedNflSchedule(reference);
  const { league } = await seedSeasonLeague(deps, { id: 'lg-cycle', owners: [ALICE], overrides });
  return { deps, league, repos, events };
}

const types = (events: InMemoryEventPublisher) => events.events.map((e) => e.detailType);

describe('advanceLeague', () => {
  it('skips leagues that are not in season, have no schedule, or are mid-week', async () => {
    const pre = await setup({ phase: 'drafting', week: null });
    expect(await advanceLeague(pre.deps, pre.league, afterWeek(1))).toMatchObject({
      reason: 'not_in_season'
    });
    const bare = await setup({}, false);
    expect(await advanceLeague(bare.deps, bare.league, afterWeek(1))).toMatchObject({
      reason: 'no_schedule'
    });
    expect(await advanceLeague(pre.deps, { ...bare.league }, new Date(MONDAY_KICKOFF))).toMatchObject({
      reason: 'week_in_progress'
    });
  });

  it('plays the regular season into the playoffs, through the bracket, to complete', async () => {
    const { deps, repos, events } = await setup({ week: 15 });
    const league = (await repos.leagues.get('lg-cycle')) as League;
    // A 4-team league: regular season ends in week 15, playoffs are weeks 16-17 with 4 teams.
    // Earlier weeks are final with the home team winning, so the standings are well defined.
    const earlier = (await repos.schedule.listMatchups(league.id)).filter((m) => m.week < 15);
    await repos.schedule.putMatchups(
      earlier.map((m) => ({ ...m, homeScore: 100, awayScore: 90, status: 'final' }))
    );

    const toPlayoffs = await advanceLeague(deps, league, afterWeek(15));
    expect(toPlayoffs).toMatchObject({ status: 'rolled_over', finalWeek: 15, week: 16, phase: 'playoffs' });
    const semis = await repos.schedule.listMatchups(league.id, 16);
    expect(semis).toHaveLength(2);
    expect(semis.every((m) => m.kind === 'playoff' && m.id.startsWith('W16-P'))).toBe(true);
    const inPlayoffs = (await repos.leagues.get(league.id)) as League;
    expect(inPlayoffs).toMatchObject({ phase: 'playoffs', week: 16 });

    // team-1's stat-less 0 ties the semifinal; the better seed advances either way.
    const toFinal = await advanceLeague(deps, inPlayoffs, afterWeek(16));
    expect(toFinal).toMatchObject({ status: 'rolled_over', week: 17, phase: 'playoffs' });
    expect(await repos.schedule.listMatchups(league.id, 17)).toHaveLength(1);
    // The standings stop at the regular season.
    expect((await repos.schedule.latestStandings(league.id))?.week).toBe(15);

    const done = await advanceLeague(deps, (await repos.leagues.get(league.id)) as League, afterWeek(17));
    expect(done).toEqual({ leagueId: league.id, status: 'completed', finalWeek: 17 });
    expect((await repos.leagues.get(league.id))?.phase).toBe('complete');
    expect(types(events).filter((t) => t === 'Week Provisionally Final')).toHaveLength(3);
    expect(await listInSeason(repos)).toEqual([]);
  });

  it('writes no playoff games without standings, and logs when the bracket cannot be paired', async () => {
    const { deps, repos } = await setup({ week: 15 });
    const league = (await repos.leagues.get('lg-cycle')) as League;
    const noSeeds = {
      ...league,
      settings: { ...league.settings, playoffs: { ...league.settings.playoffs, teams: 6, byes: 2 } }
    };
    await repos.leagues.update(noSeeds);
    const rolled = await advanceLeague(deps, (await repos.leagues.get(league.id)) as League, afterWeek(15));
    expect(rolled).toMatchObject({ status: 'rolled_over', week: 16 });
    expect(await repos.schedule.listMatchups(league.id, 16)).toEqual([]);
  });

  it('carries lineups forward but keeps a lineup the team already saved for the new week', async () => {
    const { deps, repos, league } = await setup();
    const team = (await repos.teams.get(league.id, 'team-1'))!;
    await repos.lineups.put([
      {
        leagueId: league.id,
        teamId: 'team-1',
        week: 2,
        entries: [{ playerId: 'fx-jallen', slot: 'BN' }],
        updatedAt: '2026-09-12T00:00:00.000Z',
        updatedBy: 'user#alice'
      }
    ]);
    await advanceLeague(deps, league, afterWeek(1));
    expect((await repos.lineups.get(league.id, 'team-1', 2))?.updatedBy).toBe('user#alice');
    expect((await repos.lineups.get(league.id, 'team-2', 2))?.updatedBy).toBe('system');
    expect(await repos.lineups.get(league.id, 'team-3', 2)).toBeNull();
    expect((await resolveLineup(repos, team, 2)).entries).toContainEqual({
      playerId: 'fx-jallen',
      slot: 'BN'
    });
  });

  it('resets waiver priority to reverse standings at rollover and records the new week kickoffs', async () => {
    const { deps, repos, league } = await setup({ week: 2 });
    await repos.leagues.update({
      ...league,
      settings: {
        ...league.settings,
        waivers: { ...league.settings.waivers, priorityOrder: 'reverse_standings_weekly' }
      }
    });
    const week1 = (await repos.schedule.listMatchups(league.id)).filter((m) => m.week === 1);
    await repos.schedule.putMatchups(week1.map((m) => ({ ...m, homeScore: 100, awayScore: 90, status: 'final' })));
    await advanceLeague(deps, (await repos.leagues.get(league.id)) as League, afterWeek(2));

    const standings = (await repos.schedule.latestStandings(league.id))!;
    const worstFirst = [...standings.rows].sort((a, b) => b.rank - a.rank).map((r) => r.teamId);
    const byPriority = (await repos.teams.list(league.id))
      .sort((a, b) => a.waiverPriority - b.waiverPriority)
      .map((t) => t.id);
    expect(byPriority).toEqual(worstFirst);

    const moved = (await repos.leagues.get(league.id)) as League;
    expect(moved.deadlines.lineupLocksAt).toHaveLength(4);
    expect(moved.deadlines.lineupLocksAt?.[0]).toBe(moved.deadlines.nextLineupLockAt);
  });

  it('leaves waiver priority alone under reverse_draft_continual', async () => {
    const { deps, repos, league } = await setup();
    const before = (await repos.teams.list(league.id)).map((t) => [t.id, t.waiverPriority]);
    await advanceLeague(deps, league, afterWeek(1));
    expect((await repos.teams.list(league.id)).map((t) => [t.id, t.waiverPriority])).toEqual(before);
  });

  it('emits nothing when another run already moved the league', async () => {
    const { deps, repos, league, events } = await setup();
    await repos.leagues.update({ ...league, name: 'Renamed' });
    expect(await advanceLeague(deps, league, afterWeek(1))).toMatchObject({ reason: 'concurrent_update' });
    const last = (await repos.leagues.get(league.id)) as League;
    await repos.leagues.update({ ...last, week: 17, phase: 'playoffs' });
    expect(await advanceLeague(deps, { ...last, week: 17, phase: 'playoffs' }, afterWeek(17))).toMatchObject({
      reason: 'concurrent_update'
    });
    expect(types(events)).not.toContain('Week Rolled Over');
    expect(types(events)).not.toContain('Week Provisionally Final');
  });

  it('rethrows unexpected storage failures, and the job counts them without stopping', async () => {
    const { deps, repos, league } = await setup();
    const broken = {
      ...deps,
      repos: {
        ...repos,
        leagues: {
          ...repos.leagues,
          listByPhase: repos.leagues.listByPhase.bind(repos.leagues),
          update: async () => Promise.reject(new Error('dynamo down'))
        }
      }
    };
    await expect(advanceLeague(broken, league, afterWeek(1))).rejects.toThrow('dynamo down');
    expect(await advanceSeason(broken, new FixedClock(afterWeek(1)))).toMatchObject({ failed: 1 });
  });
});

describe('season jobs with nothing to do', () => {
  it('skip when no league is in season', async () => {
    const repos = createInMemoryRepos();
    const deps = {
      repos,
      reference: createInMemoryReferenceStore(repos.players),
      events: new InMemoryEventPublisher(),
      log: silentLogger
    };
    const clock = new FixedClock(afterWeek(1));
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({
      status: 'skipped',
      reason: 'no_leagues_in_season'
    });
    expect(await advanceSeason(deps, clock)).toMatchObject({
      status: 'skipped',
      reason: 'no_leagues_in_season'
    });
  });

  it('live scoring ignores a league without a week or without matchups', async () => {
    const { deps, repos, league } = await setup();
    await repos.schedule.putMatchups([]);
    await repos.leagues.update({ ...league, week: 3 });
    const clock = new FixedClock(new Date(Date.parse(MONDAY_KICKOFF) + 2 * WEEK_MS + 3_600_000));
    // Week 3 is live, but the league has no week-3 stats yet: scores become 0-0 in progress.
    expect(await scoreLiveWeek(deps, clock)).toMatchObject({ status: 'ok', live: 1 });
    const noWeek = await setup({ week: null });
    expect(await scoreLiveWeek(noWeek.deps, clock)).toMatchObject({ reason: 'outside_game_window' });
  });
});

describe('scheduleLockWarnings', () => {
  it('schedules one warning per upcoming window, sent right away when the lead has passed', async () => {
    const { deps, league } = await setup();
    const games = await deps.reference.schedule.getWeek(SEASON, 1);
    // 30 minutes before the Sunday 1pm window: Thursday is over, Sunday's lead time has passed.
    const now = new Date('2026-09-13T16:30:00.000Z');
    expect(await scheduleLockWarnings(deps, league, games, now)).toBe(3);
    const [first] = deps.events.events;
    expect(first?.detail).toMatchObject({
      at: now.toISOString(),
      whenPast: 'send',
      name: 'lineup-lock-lg-cycle-W01-2',
      event: {
        detail: { lockAt: '2026-09-13T17:00:00.000Z', nflTeams: ['ARI', 'BUF', 'CIN', 'DET', 'MIA', 'SF'] }
      }
    });
  });
});

describe('startLeagueSeason (#85)', () => {
  const state = (week: number, seasonType: 'pre' | 'regular' = 'regular') => ({
    season: SEASON,
    seasonType,
    week,
    displayWeek: week,
    leagueSeason: SEASON,
    previousSeason: SEASON - 1,
    seasonStartDate: '2026-09-10',
    updatedAt: '2026-09-01T00:00:00.000Z'
  });

  it('starts a league drafted before the season in its start week', async () => {
    const { deps, repos } = await setup({ phase: 'drafting', week: null });
    await deps.reference.nflState.put(state(1, 'pre'), null);
    const started = await startLeagueSeason(
      deps,
      (await repos.leagues.get('lg-cycle')) as League,
      new Date('2026-09-01T00:00:00Z')
    );
    expect(started).toMatchObject({ phase: 'regular_season', week: 1 });
    expect(started.deadlines.nextLineupLockAt).toBe('2026-09-11T00:20:00.000Z');
    expect(deps.events.events.filter((e) => e.detailType === 'Schedule Event')).toHaveLength(4);
  });

  it('starts a league drafted mid-season at the next unlocked week', async () => {
    const { deps, repos } = await setup({ phase: 'regular_season', week: null });
    const now = new Date(Date.parse('2026-09-11T00:20:00.000Z') + 3 * WEEK_MS + 3_600_000);
    const started = await startLeagueSeason(
      { ...deps, nflState: { getNflState: async () => state(4) } },
      (await repos.leagues.get('lg-cycle')) as League,
      now
    );
    expect(started).toMatchObject({ phase: 'regular_season', week: 5 });
  });

  it('refuses when the regular season is over, and falls back to the clock without a stored state', async () => {
    const { deps, repos } = await setup({ phase: 'drafting', week: null });
    const league = (await repos.leagues.get('lg-cycle')) as League;
    await expect(
      startLeagueSeason(
        { ...deps, nflState: { getNflState: async () => ({ ...state(1), seasonType: 'post' }) } },
        league,
        new Date('2027-01-20T00:00:00Z')
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(storedNflState(deps.reference).getNflState(new Date())).rejects.toThrow('No NFL state');
    // No stored NFL state: the week is estimated from the clock (before week 1 kicks off).
    const started = await startLeagueSeason(deps, league, new Date('2026-08-20T00:00:00Z'));
    expect(started.week).toBe(1);
  });
});
