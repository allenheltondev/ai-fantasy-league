import {
  firstKickoff,
  gameWindows,
  kickoffTimes,
  nextLeagueWeek,
  reverseStandingsOrder,
  weekEndsAt
} from '@fantasy/core';
import type { ScheduledGame } from '@fantasy/data';
import { ApiError, isApiError } from '../errors.js';
import { STATS_GAME_DURATION_MS } from './window.js';
import { firstScoringWeek, nextUnlockedWeek, type NflStateSource } from '../league/calendar.js';
import { isInSeason, transitionPhase } from '../league/phase.js';
import { startSeasonSchedule } from '../league/schedule.js';
import { weekKey } from '../repos/dynamo/query.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Lineup, Repos } from '../repos/types.js';
import { applyPriorities } from '../waivers/process.js';
import { resolveWeekLineups, weekGames, type SeasonDeps } from './lineups.js';
import { rebuildPlayoffs, recordSeasonHistory, writePlayoffGames } from './playoffs.js';
import { recordStandings, scoreLine, updateMatchupScores } from './scoring.js';

/**
 * The weekly cycle (#54, #56), driven by the clock so the simulator can run it: once a week's last
 * game is over the week is provisionally final, and the league rolls to the next week (or into the
 * playoffs, or to `complete`). Lineup-lock warnings are deferred events scheduled at each rollover.
 * See docs/adr/002-weekly-cycle.md.
 */

/** How long before a game window's first kickoff agents are told lineups are about to lock. */
export const LOCK_WARNING_LEAD_MS = 60 * 60 * 1000;

export type AdvanceOutcome =
  | { leagueId: string; status: 'skipped'; reason: string }
  | { leagueId: string; status: 'rolled_over'; finalWeek: number; week: number; phase: string }
  | { leagueId: string; status: 'completed'; finalWeek: number };

/**
 * Moves one league forward if its current week is over: final scores, a standings snapshot (in
 * the regular season), `Week Provisionally Final`, then the rollover: lineups carried forward, the
 * next week's playoff games when there are any, `Week Rolled Over`, and the next week's lock
 * warnings. Safe to run repeatedly: before the week ends it does nothing, every write is
 * idempotent, and the version-checked league update is the commit point, so a concurrent run that
 * loses the race emits nothing.
 */
export async function advanceLeague(deps: SeasonDeps, league: League, now: Date): Promise<AdvanceOutcome> {
  const skip = (reason: string): AdvanceOutcome => ({ leagueId: league.id, status: 'skipped', reason });
  if (league.week === null || !isInSeason(league)) return skip('not_in_season');
  const phase = league.phase as 'regular_season' | 'playoffs';
  const week = league.week;
  const endsAt = weekEndsAt(await weekGames(deps.reference, league.season, week), STATS_GAME_DURATION_MS);
  if (endsAt === null) return skip('no_schedule');
  if (now.getTime() < Date.parse(endsAt)) return skip('week_in_progress');

  const scored = await updateMatchupScores(deps, league, week, 'final', now);
  if (phase === 'regular_season') await recordStandings(deps, league, week, now);
  const final = {
    leagueId: league.id,
    season: league.season,
    week,
    matchups: scored.matchups.map(scoreLine),
    finalizedAt: now.toISOString()
  };

  const step = nextLeagueWeek(league.settings, phase, week);
  // The bracket advances with this week's results (or is seeded as the playoffs start).
  const playoffs = step.phase === 'regular_season' ? null : await rebuildPlayoffs(deps, league, now);
  if (step.phase === 'complete') {
    const completed = await commit(deps.repos, transitionPhase(league, 'complete', now));
    if (completed === null) return skip('concurrent_update');
    const history = await recordSeasonHistory(deps, completed, playoffs, now);
    await deps.events.publish('Week Provisionally Final', final);
    await deps.events.publish('Season Completed', {
      leagueId: league.id,
      season: league.season,
      championTeamId: history.championTeamId,
      runnerUpTeamId: history.runnerUpTeamId,
      consolationChampionTeamId: history.consolationChampionTeamId,
      completedAt: now.toISOString()
    });
    return { leagueId: league.id, status: 'completed', finalWeek: week };
  }

  if (playoffs !== null) await writePlayoffGames(deps, league, playoffs.bracket, step.week);
  await carryLineupsForward(deps.repos, league, week, step.week, now);
  const nextGames = await weekGames(deps.reference, league.season, step.week);
  const moved = step.phase === phase ? league : transitionPhase(league, step.phase, now);
  const saved = await commit(deps.repos, {
    ...moved,
    week: step.week,
    deadlines: weekDeadlines(moved, nextGames),
    updatedAt: now.toISOString()
  });
  if (saved === null) return skip('concurrent_update');
  if (league.settings.waivers.priorityOrder === 'reverse_standings_weekly') {
    await resetPriorityToStandings(deps.repos, league.id, now);
  }

  await deps.events.publish('Week Provisionally Final', final);
  await deps.events.publish('Week Rolled Over', {
    leagueId: league.id,
    season: league.season,
    fromWeek: week,
    week: step.week,
    phase: step.phase,
    rolledOverAt: now.toISOString()
  });
  await scheduleLockWarnings(deps, saved, nextGames, now);
  return { leagueId: league.id, status: 'rolled_over', finalWeek: week, week: step.week, phase: step.phase };
}

/**
 * The week's lock deadlines: every kickoff (`lineupLocksAt`, so `preLock` and the next lock move on
 * after Thursday night) and the first one.
 */
function weekDeadlines(league: League, games: readonly ScheduledGame[]): League['deadlines'] {
  return {
    ...league.deadlines,
    nextLineupLockAt: firstKickoff(games),
    lineupLocksAt: kickoffTimes(games)
  };
}

/**
 * `priorityOrder: reverse_standings_weekly`: at every rollover the waiver priority list resets to
 * the latest standings, worst record first (core `reverseStandingsOrder`).
 */
async function resetPriorityToStandings(repos: Repos, leagueId: string, now: Date): Promise<void> {
  const [standings, teams] = await Promise.all([
    repos.schedule.latestStandings(leagueId),
    repos.teams.list(leagueId)
  ]);
  if (standings === null) return;
  const current = [...teams].sort((a, b) => a.waiverPriority - b.waiverPriority).map((t) => t.id);
  await applyPriorities(repos, leagueId, reverseStandingsOrder(standings.rows, current), now);
}

/** The version-checked league write; null when another writer got there first. */
async function commit(repos: Repos, league: League): Promise<League | null> {
  try {
    return await repos.leagues.update(league);
  } catch (error) {
    if (isApiError(error) && error.code === 'CONFLICT') return null;
    throw error;
  }
}

/** Copies every team's lineup into the new week, unless the team already saved one for it. */
async function carryLineupsForward(
  repos: Repos,
  league: League,
  fromWeek: number,
  toWeek: number,
  now: Date
): Promise<void> {
  const teams = (await repos.teams.list(league.id)).filter((t) => t.roster.length > 0);
  const already = new Set((await repos.lineups.listWeek(league.id, toWeek)).map((l) => l.teamId));
  const previous = await resolveWeekLineups(repos, teams, fromWeek);
  const carried: Lineup[] = teams
    .filter((t) => !already.has(t.id))
    .map((t) => ({
      leagueId: league.id,
      teamId: t.id,
      week: toWeek,
      entries: previous.get(t.id)?.entries ?? [],
      updatedAt: now.toISOString(),
      updatedBy: 'system'
    }));
  await repos.lineups.put(carried);
}

/**
 * Schedules `Lineup Lock Approaching` (a deferred event through the rsc-core scheduler) before
 * each game window of the league's week that has not started. Names are stable per league, week,
 * and window, so scheduling again moves the pending event instead of adding another.
 */
export async function scheduleLockWarnings(
  deps: Pick<SeasonDeps, 'events'>,
  league: League,
  games: readonly ScheduledGame[],
  now: Date
): Promise<number> {
  let scheduled = 0;
  const week = league.week as number;
  for (const [i, window] of gameWindows(games).entries()) {
    const lockAt = Date.parse(window.startsAt);
    if (lockAt <= now.getTime()) continue;
    await deps.events.scheduleAt({
      at: new Date(Math.max(now.getTime(), lockAt - LOCK_WARNING_LEAD_MS)),
      name: `lineup-lock-${league.id}-${weekKey(week)}-${i + 1}`,
      whenPast: 'send',
      event: {
        detailType: 'Lineup Lock Approaching',
        detail: {
          leagueId: league.id,
          season: league.season,
          week,
          lockAt: window.startsAt,
          nflTeams: window.teams
        }
      }
    });
    scheduled++;
  }
  return scheduled;
}

/** The stored NFL state (written by the syncNflState job) as a calendar source. */
export function storedNflState(reference: ReferenceStore): NflStateSource {
  return {
    async getNflState() {
      const state = await reference.nflState.get();
      if (state === null) throw new Error('No NFL state is stored yet.');
      return state;
    }
  };
}

/**
 * Starts a drafted league's season (#85). `finishDraft` calls this once it has moved the league to
 * `regular_season` with its first week (`max(startWeek, current NFL week)`); a league still in
 * `drafting` (or without a week) gets the first unlocked week (`firstScoringWeek`). It makes sure
 * the schedule exists, sets the week and the next lineup lock, and schedules the week's lock
 * warnings. Weeks before the first week are void: their matchups stay `scheduled` without
 * scores, never count in the standings, and get_matchup says so (WEEK_VOID).
 */
export async function startLeagueSeason(
  deps: SeasonDeps & { nflState?: NflStateSource },
  league: League,
  now: Date
): Promise<League> {
  // The draft (league/draft.ts `finishDraft`) picks the first week itself; keep its choice.
  const week =
    league.phase === 'regular_season' && league.week !== null
      ? league.week
      : firstScoringWeek(
          league,
          await nextUnlockedWeek(deps.nflState ?? storedNflState(deps.reference), now, deps.log)
        );
  const lastWeek = league.settings.schedule.regularSeasonEndWeek;
  if (week > lastWeek) {
    throw new ApiError(
      'CONFLICT',
      `Every regular-season week of the ${league.season} season has kicked off.`,
      {
        fix: `This league cannot start scoring this season: its regular season ends in week ${lastWeek}. Create a league for next season instead.`,
        details: { firstScoringWeek: week, regularSeasonEndWeek: lastWeek }
      }
    );
  }
  await startSeasonSchedule(deps, league);
  const games = await weekGames(deps.reference, league.season, week);
  const moved = league.phase === 'drafting' ? transitionPhase(league, 'regular_season', now) : league;
  const saved = await deps.repos.leagues.update({
    ...moved,
    week,
    deadlines: weekDeadlines(moved, games),
    updatedAt: now.toISOString()
  });
  await scheduleLockWarnings(deps, saved, games, now);
  return saved;
}
