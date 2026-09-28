import { ACHIEVEMENTS, type AchievementAward } from '@fantasy/core';
import { weekKey } from '../repos/dynamo/query.js';
import type { AchievementRecord } from '../repos/history.js';
import type { League } from '../repos/types.js';
import type { SeasonDeps } from './lineups.js';

/**
 * League achievements (#82). Awards are stored per league for every team (agents earn them too),
 * announced once with `Achievement Earned` (which the chat posts), and, when the badge chest is on,
 * reported to rsc-core's badge chest for the team's human owner as a `Track Activity` event: the
 * rsc-core rules engine matches on that detail type and keys badges on `action`
 * (functions/badges/AGENTS.md in rsc-core). The `id` makes each activity count exactly once.
 *
 * The badge chest is off unless `BADGE_CHEST_ENABLED=true` on the data jobs function, so local dev,
 * tests, and CI emit nothing for it; its catalog entries live in rsc-core.
 */

export const BADGE_SERVICE = 'fantasy';

export interface AchievementDeps extends Pick<SeasonDeps, 'repos' | 'events'> {
  /** Report awards to the rsc-core badge chest. */
  badgeChest?: boolean;
}

export function achievementRecordId(season: number, award: AchievementAward): string {
  const when = award.week === null ? 'season' : weekKey(award.week);
  return `${award.achievementId}#${season}#${when}#${award.teamId}`;
}

/** Stores the awards; announces (and reports to the badge chest) only the ones not stored before. */
export async function awardAchievements(
  deps: AchievementDeps,
  league: League,
  awards: readonly AchievementAward[],
  now: Date
): Promise<AchievementRecord[]> {
  if (awards.length === 0) return [];
  const records: AchievementRecord[] = awards.map((award) => ({
    id: achievementRecordId(league.season, award),
    leagueId: league.id,
    season: league.season,
    achievementId: award.achievementId,
    teamId: award.teamId,
    week: award.week,
    reason: award.reason,
    awardedAt: now.toISOString()
  }));
  const added = await deps.repos.history.addAchievements(records);
  if (added.length === 0) return [];
  const owners = new Map((await deps.repos.teams.list(league.id)).map((t) => [t.id, t.ownerUserId]));
  for (const record of added) {
    const definition = ACHIEVEMENTS[record.achievementId];
    await deps.events.publish('Achievement Earned', {
      leagueId: league.id,
      season: league.season,
      teamId: record.teamId,
      achievementId: record.achievementId,
      name: definition.name,
      reason: record.reason,
      week: record.week,
      awardedAt: record.awardedAt
    });
    const userId = owners.get(record.teamId) ?? null;
    if (deps.badgeChest === true && userId !== null) {
      await deps.events.publish('Track Activity', {
        id: `fantasy#${league.id}#${record.id}`,
        userId,
        action: definition.badgeAction,
        service: BADGE_SERVICE,
        value: league.id
      });
    }
  }
  return added;
}
