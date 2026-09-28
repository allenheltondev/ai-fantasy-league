import { yahooDefaultSettings } from '@fantasy/core';
import type { League, Repos, Team } from '../../src/repos/types.js';
import { seedLeague, type SeededLeague } from './leagues.js';

/**
 * An in-season league for waiver tests, with rosters written straight to the teams (the draft
 * stream fills them for real). Rosters are small (QB, RB, BN: 3 active spots) so a full roster
 * takes three fixture players.
 */
export async function seedSeasonLeague(
  repos: Repos,
  options: {
    id: string;
    owners: readonly ({ sub: string; name: string } | null)[];
    rosters: Record<string, string[]>;
    overrides?: Partial<League>;
    teamCount?: number;
  }
): Promise<SeededLeague> {
  const teamCount = options.teamCount ?? 4;
  const settings = yahooDefaultSettings(teamCount);
  settings.roster.slots = { QB: 1, RB: 1, BN: 1 };
  const seeded = await seedLeague(repos, {
    id: options.id,
    owners: options.owners,
    teamCount,
    overrides: { phase: 'regular_season', week: 2, settings, ...options.overrides }
  });
  const teams: Team[] = [];
  for (const team of seeded.teams) {
    const roster = options.rosters[team.id];
    teams.push(roster === undefined ? team : await repos.teams.update({ ...team, roster }));
  }
  return { league: seeded.league, teams };
}
