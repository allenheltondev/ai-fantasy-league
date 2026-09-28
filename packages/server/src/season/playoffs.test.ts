import { describe, expect, it } from 'vitest';
import { ALICE } from '../../test/support/leagues.js';
import { seedNflSchedule, seedSeasonLeague } from '../../test/support/season.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { silentLogger } from '../log.js';
import { createInMemoryReferenceStore } from '../repos/memory-reference.js';
import { createInMemoryRepos } from '../repos/memory.js';
import type { League } from '../repos/types.js';
import { awardAchievements } from './achievements.js';
import { rebuildPlayoffs, recordSeasonHistory, writePlayoffGames } from './playoffs.js';
import { recordStandings } from './scoring.js';

const NOW = new Date('2026-12-29T15:00:00.000Z');

async function setup() {
  const repos = createInMemoryRepos();
  const reference = createInMemoryReferenceStore(repos.players);
  const events = new InMemoryEventPublisher();
  const deps = { repos, reference, events, log: silentLogger };
  await seedNflSchedule(reference);
  const { league } = await seedSeasonLeague(deps, {
    id: 'lg-po',
    owners: [ALICE],
    overrides: { week: 16, phase: 'playoffs' }
  });
  return { deps, league: league as League };
}

describe('playoffs', () => {
  it('has no bracket or archive details before the regular season is final', async () => {
    const { deps, league } = await setup();
    expect(await rebuildPlayoffs(deps, league, NOW)).toBeNull();
    const history = await recordSeasonHistory(deps, league, null, NOW);
    expect(history).toMatchObject({
      championTeamId: null,
      runnerUpTeamId: null,
      finalStandings: [],
      playoffResults: []
    });
  });

  it('writes a week of bracket games once, and archives an away champion with its runner-up', async () => {
    const { deps, league } = await setup();
    await recordStandings(deps, league, 15, NOW);
    const playoffs = await rebuildPlayoffs(deps, league, NOW);
    expect(playoffs).not.toBeNull();
    const bracket = playoffs!.bracket;
    expect(await writePlayoffGames(deps, league, bracket, 16)).toHaveLength(2);
    expect(await writePlayoffGames(deps, league, bracket, 16)).toEqual([]);

    const final = bracket.games.find((g) => g.id === bracket.finalGameId)!;
    const decided = {
      ...playoffs!,
      championTeamId: 'team-4',
      bracket: {
        ...bracket,
        games: bracket.games.map((g) =>
          g.id === final.id
            ? {
                ...g,
                home: { ...g.home, teamId: 'team-1' },
                away: { ...g.away, teamId: 'team-4' },
                winnerTeamId: 'team-4'
              }
            : g
        )
      }
    };
    await deps.repos.teams.update({ ...(await deps.repos.teams.get(league.id, 'team-2'))!, name: 'Renamed' });
    const history = await recordSeasonHistory(deps, league, decided, NOW);
    expect(history).toMatchObject({ championTeamId: 'team-4', runnerUpTeamId: 'team-1' });
    expect(history.finalStandings).toHaveLength(4);
    // A second write keeps the original completion time.
    const later = await recordSeasonHistory(deps, league, decided, new Date('2027-01-05T00:00:00.000Z'));
    expect(later.completedAt).toBe(NOW.toISOString());

    // Deleting the league deletes its history too (one partition in DynamoDB).
    await deps.repos.history.addAchievements([
      {
        id: 'a',
        leagueId: league.id,
        season: 2026,
        achievementId: 'blowout-win',
        teamId: 'team-1',
        week: 3,
        reason: 'r',
        awardedAt: NOW.toISOString()
      }
    ]);
    await deps.repos.leagues.delete(league.id);
    expect(await deps.repos.history.getPlayoffs(league.id)).toBeNull();
    expect(await deps.repos.history.listSeasons(league.id)).toEqual([]);
    expect(await deps.repos.history.listAchievements(league.id)).toEqual([]);
  });

  it('announces each achievement once and skips empty award lists', async () => {
    const { deps, league } = await setup();
    const award = { achievementId: 'blowout-win' as const, teamId: 'team-1', week: 3, reason: 'Won by 60' };
    expect(await awardAchievements(deps, league, [], NOW)).toEqual([]);
    expect(await awardAchievements(deps, league, [award], NOW)).toHaveLength(1);
    expect(await awardAchievements(deps, league, [award], NOW)).toEqual([]);
    expect(deps.events.events.filter((e) => e.detailType === 'Achievement Earned')).toHaveLength(1);
    // The badge chest is off by default.
    expect(deps.events.events.filter((e) => e.detailType === 'Track Activity')).toEqual([]);
  });
});
