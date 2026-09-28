import { startSeasonSchedule } from '../../src/league/schedule.js';
import { TEAM1_LINEUP, TEAM1_ROSTER, TEAM2_ROSTER } from '../../src/dev/season-demo.js';
import type { ReferenceStore } from '../../src/repos/reference.js';
import type { League, Repos, Team } from '../../src/repos/types.js';
import { seedLeague } from './leagues.js';

/**
 * An in-season league for the season-loop tests: four teams (team-1 and team-2 have full rosters
 * of fixture players), phase `regular_season`, week 1 of 2026, the schedule generated, and NFL
 * games stored for weeks 1-18 (each week one week after the last). The data is the local demo
 * league's (src/dev/season-demo.ts).
 */

export {
  MONDAY_KICKOFF,
  nflGames,
  SEASON,
  seedNflSchedule,
  SUNDAY_KICKOFF,
  TEAM1_LINEUP,
  TEAM1_ROSTER,
  TEAM2_ROSTER,
  THURSDAY_KICKOFF
} from '../../src/dev/season-demo.js';

export interface SeasonLeague {
  league: League;
  teams: Team[];
}

/** Seeds the in-season league. `owners` as in `seedLeague` (the first is the commissioner). */
export async function seedSeasonLeague(
  deps: { repos: Repos; reference: ReferenceStore },
  options: {
    id: string;
    owners: readonly ({ sub: string; name: string } | null)[];
    overrides?: Partial<League>;
    lineup?: boolean;
  }
): Promise<SeasonLeague> {
  const seeded = await seedLeague(deps.repos, {
    id: options.id,
    owners: options.owners,
    teamCount: 4,
    overrides: { phase: 'regular_season', week: 1, ...options.overrides }
  });
  const teams: Team[] = [];
  for (const team of seeded.teams) {
    const roster = team.id === 'team-1' ? TEAM1_ROSTER : team.id === 'team-2' ? TEAM2_ROSTER : [];
    teams.push(await deps.repos.teams.update({ ...team, roster: [...roster] }));
  }
  await startSeasonSchedule(deps, seeded.league);
  if (options.lineup !== false) {
    await deps.repos.lineups.put([
      {
        leagueId: options.id,
        teamId: 'team-1',
        week: seeded.league.week ?? 1,
        entries: TEAM1_LINEUP.map((e) => ({ ...e })),
        updatedAt: '2026-09-10T00:00:00.000Z',
        updatedBy: 'user#seed'
      }
    ]);
  }
  return { league: (await deps.repos.leagues.get(options.id)) as League, teams };
}
