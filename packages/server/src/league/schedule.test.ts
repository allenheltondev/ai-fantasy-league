import { describe, expect, it, vi } from 'vitest';
import { ALICE, seedLeague } from '../../test/support/leagues.js';
import { createInMemoryRepos } from '../repos/memory.js';
import { startSeasonSchedule } from './schedule.js';

describe('startSeasonSchedule', () => {
  it('generates and stores a round robin for the league weeks', async () => {
    const repos = createInMemoryRepos();
    const { league } = await seedLeague(repos, { id: 'lg-s', owners: [ALICE] });
    const matchups = await startSeasonSchedule({ repos }, league);
    // 8 teams, weeks 1-14: 4 games a week.
    expect(matchups).toHaveLength(14 * 4);
    expect(matchups[0]).toMatchObject({
      id: 'W01-1',
      leagueId: 'lg-s',
      week: 1,
      kind: 'regular',
      homeScore: null,
      status: 'scheduled'
    });
    for (let week = 1; week <= 14; week++) {
      const teams = matchups.filter((m) => m.week === week).flatMap((m) => [m.homeTeamId, m.awayTeamId]);
      expect(new Set(teams).size).toBe(8);
    }
    expect(await repos.schedule.listMatchups('lg-s')).toEqual(matchups);
    expect(await repos.schedule.listMatchups('lg-s', 3)).toHaveLength(4);
  });

  it('is deterministic and does not regenerate a stored schedule', async () => {
    const a = createInMemoryRepos();
    const b = createInMemoryRepos();
    const { league } = await seedLeague(a, { id: 'lg-d', owners: [ALICE] });
    await seedLeague(b, { id: 'lg-d', owners: [ALICE] });
    const first = await startSeasonSchedule({ repos: a }, league);
    expect(await startSeasonSchedule({ repos: b }, league)).toEqual(first);
    const put = vi.spyOn(a.schedule, 'putMatchups');
    expect(await startSeasonSchedule({ repos: a }, league)).toEqual(first);
    expect(put).not.toHaveBeenCalled();
  });

  it('plays only the remaining weeks of a mid-season start', async () => {
    const repos = createInMemoryRepos();
    const { league } = await seedLeague(repos, { id: 'lg-m', owners: [ALICE], teamCount: 6 });
    const midSeason = {
      ...league,
      settings: { ...league.settings, schedule: { ...league.settings.schedule, startWeek: 9 } }
    };
    const matchups = await startSeasonSchedule({ repos }, midSeason);
    expect(new Set(matchups.map((m) => m.week))).toEqual(new Set([9, 10, 11, 12, 13, 14, 15]));
  });

  it('refuses settings or seats it cannot schedule, with a fix', async () => {
    const repos = createInMemoryRepos();
    const { league } = await seedLeague(repos, { id: 'lg-x', owners: [ALICE] });
    const late = {
      ...league,
      settings: { ...league.settings, schedule: { ...league.settings.schedule, startWeek: 12 } }
    };
    await expect(startSeasonSchedule({ repos }, late)).rejects.toMatchObject({
      code: 'INVALID_SETTINGS',
      details: { issues: [expect.objectContaining({ code: 'START_AFTER_TRADE_DEADLINE' })] }
    });
    await repos.teams.deleteUnowned('lg-x', 'team-8');
    await expect(startSeasonSchedule({ repos }, league)).rejects.toMatchObject({
      code: 'INVALID_SETTINGS',
      details: { issues: [expect.objectContaining({ code: 'SCHEDULE_ODD_TEAMS' })] }
    });
    await repos.teams.deleteUnowned('lg-x', 'team-7');
    await expect(startSeasonSchedule({ repos }, league)).rejects.toMatchObject({
      code: 'CONFLICT',
      fix: expect.stringContaining('teamCount')
    });
  });
});
