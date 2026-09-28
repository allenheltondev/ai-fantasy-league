import {
  computeStandings,
  scoreTeamWeek,
  type FinalizedMatchup,
  type StatLine,
  type TeamWeekScore
} from '@fantasy/core';
import type { League, Matchup, StandingsSnapshot } from '../repos/types.js';
import { resolveWeekLineups, type SeasonDeps } from './lineups.js';

/**
 * Matchup scoring: each team's starters scored from the stored stat lines with the league's
 * scoring settings (core `scoreTeamWeek`), written onto the week's matchups, and standings
 * snapshots once a week is final.
 */

/** Every team's score for a week, keyed by team id. Only starters count. */
export async function scoreWeek(
  deps: Pick<SeasonDeps, 'repos' | 'reference'>,
  league: League,
  week: number
): Promise<Map<string, TeamWeekScore>> {
  const [teams, lines] = await Promise.all([
    deps.repos.teams.list(league.id),
    deps.reference.stats.getWeek(league.season, week)
  ]);
  const stats: Record<string, StatLine> = {};
  for (const line of lines) stats[line.playerId] = line.stats;
  const lineups = await resolveWeekLineups(deps.repos, teams, week);
  const scores = new Map<string, TeamWeekScore>();
  for (const [teamId, lineup] of lineups)
    scores.set(teamId, scoreTeamWeek(league.settings, lineup.entries, stats));
  return scores;
}

export interface ScoredMatchups {
  matchups: Matchup[];
  /** Matchups whose score or status changed and were written. */
  changed: Matchup[];
}

/**
 * Recomputes the week's matchup scores and writes the ones that changed. `status` is
 * `in_progress` while games are live and `final` once the week is over. Final matchups are never
 * reopened by a live pass.
 */
export async function updateMatchupScores(
  deps: Pick<SeasonDeps, 'repos' | 'reference'>,
  league: League,
  week: number,
  status: 'in_progress' | 'final'
): Promise<ScoredMatchups> {
  const stored = await deps.repos.schedule.listMatchups(league.id, week);
  if (stored.length === 0) return { matchups: [], changed: [] };
  const scores = await scoreWeek(deps, league, week);
  const matchups: Matchup[] = [];
  const changed: Matchup[] = [];
  for (const m of stored) {
    if (m.status === 'final' && status !== 'final') {
      matchups.push(m);
      continue;
    }
    const next: Matchup = {
      ...m,
      homeScore: scores.get(m.homeTeamId)?.points ?? 0,
      awayScore: scores.get(m.awayTeamId)?.points ?? 0,
      status
    };
    matchups.push(next);
    if (next.homeScore !== m.homeScore || next.awayScore !== m.awayScore || next.status !== m.status) {
      changed.push(next);
    }
  }
  if (changed.length > 0) await deps.repos.schedule.putMatchups(changed);
  return { matchups, changed };
}

/** Regular-season standings through `week`, from every final regular-season matchup, stored as a snapshot. */
export async function recordStandings(
  deps: Pick<SeasonDeps, 'repos'>,
  league: League,
  week: number,
  now: Date
): Promise<StandingsSnapshot> {
  const [matchups, teams] = await Promise.all([
    deps.repos.schedule.listMatchups(league.id),
    deps.repos.teams.list(league.id)
  ]);
  const finalized: FinalizedMatchup[] = matchups.flatMap((m) =>
    m.kind === 'regular' &&
    m.status === 'final' &&
    m.week <= week &&
    m.homeScore !== null &&
    m.awayScore !== null
      ? [
          {
            week: m.week,
            homeTeamId: m.homeTeamId,
            awayTeamId: m.awayTeamId,
            homeScore: m.homeScore,
            awayScore: m.awayScore
          }
        ]
      : []
  );
  const snapshot: StandingsSnapshot = {
    leagueId: league.id,
    week,
    rows: computeStandings(league.settings, finalized, {
      teamIds: teams.map((t) => t.id),
      seed: league.scheduleSeed
    }),
    computedAt: now.toISOString()
  };
  await deps.repos.schedule.putStandings(snapshot);
  return snapshot;
}

/** The compact score line events carry. */
export function scoreLine(m: Matchup) {
  return {
    matchupId: m.id,
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    status: m.status
  };
}
