import {
  composeBehavior,
  computeSituation,
  normalizePlayerStatus,
  type EffectiveBehavior,
  type SituationalState
} from '@fantasy/core';
import { rosterStatus, type Services } from '@fantasy/server';
import type { TaskContext } from './tasks/kinds.js';

/**
 * Situational adaptation (#217): the manager's competitive stakes and roster health, read from the
 * league's own records before a task prepares. Finalized games only (a live score never counts),
 * the team's current designations, and the league's settings: core `computeSituation` does the rest.
 * Adds repository reads, no tool call, model call, action, or scheduled work. When anything is
 * missing it returns undefined and the task keeps the archetype's unchanged baseline.
 */
export async function readSituation(
  services: Services,
  ctx: TaskContext
): Promise<SituationalState | undefined> {
  const { league } = ctx;
  if (league.phase !== 'regular_season' && league.phase !== 'playoffs') return undefined;
  try {
    const [matchups, teams] = await Promise.all([
      services.repos.schedule.listMatchups(league.id),
      services.repos.teams.list(league.id)
    ]);
    const team = teams.find((t) => t.id === ctx.principal.teamId);
    const players = team === undefined ? null : await services.repos.players.getMany(team.roster);
    return computeSituation({
      teamId: ctx.principal.teamId,
      settings: league.settings,
      phase: league.phase,
      week: league.week,
      teamIds: teams.map((t) => t.id),
      finalized: matchups.flatMap((m) =>
        m.status === 'final' && m.homeScore !== null && m.awayScore !== null
          ? [
              {
                week: m.week,
                kind: m.kind,
                homeTeamId: m.homeTeamId,
                awayTeamId: m.awayTeamId,
                homeScore: m.homeScore,
                awayScore: m.awayScore
              }
            ]
          : []
      ),
      roster:
        players?.map((p) => ({
          position: p.position,
          status: normalizePlayerStatus(p.injuryStatus, rosterStatus(p))
        })) ?? null,
      standingsSeed: league.scheduleSeed
    });
  } catch (error) {
    // Adaptation is optional: a failed read must never block a lineup before its lock.
    ctx.log.warn('agent situation unavailable; using the baseline strategy', { taskId: ctx.taskId, error });
    return undefined;
  }
}

/** What the deterministic code applies: the archetype bent by the situation, within core's caps. */
export function effectiveBehavior(ctx: Pick<TaskContext, 'config' | 'situation'>): EffectiveBehavior {
  return composeBehavior(ctx.config, ctx.situation);
}
