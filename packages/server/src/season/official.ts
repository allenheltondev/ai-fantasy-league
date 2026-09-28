import { matchupResult, seasonAchievements, weekAchievements } from '@fantasy/core';
import type { MatchupScoreSnapshot, OfficialWeekRecord } from '../repos/history.js';
import type { League, Matchup } from '../repos/types.js';
import { awardAchievements, type AchievementDeps } from './achievements.js';
import type { SeasonDeps } from './lineups.js';
import { playedGames, rebuildPlayoffs, recordSeasonHistory, writePlayoffGames } from './playoffs.js';
import { recordStandings, scoreLine, scoreWeek } from './scoring.js';

/**
 * The Thursday official final (#80). Once the stat-correction window has closed, the week's stored
 * stats have been replaced with the official ones (the `officialFinal` job), and each league's week
 * is rescored from the lineups it was played with. Matchups whose score changed get
 * `Stat Correction Applied`; standings are recomputed from the corrected week on, the bracket is
 * rebuilt when a playoff seed or winner may have changed, and `Week Official Final` closes the
 * week. The week's achievements are awarded here, once the scores are official.
 *
 * Idempotent per league and week: an `OFFICIAL#W05` claim holds the provisional scores, so a run
 * that crashes is taken over later with the same "before" scores and reports the same corrections;
 * a completed week is never finalized again. The claim is completed last, after the events and
 * the (idempotent) achievement awards (#123), so a run that fails partway is retried whole rather
 * than losing what it had not yet done: its events are at least once, never lost.
 */

/** A crashed run's claim may be taken over after this long. */
export const OFFICIAL_CLAIM_STALE_MS = 15 * 60 * 1000;

export type OfficialOutcome =
  | { leagueId: string; week: number; status: 'skipped'; reason: string }
  | { leagueId: string; week: number; status: 'official'; corrections: number; flipped: number };

type OfficialDeps = SeasonDeps & AchievementDeps;

const snapshot = (m: Matchup): MatchupScoreSnapshot => ({
  matchupId: m.id,
  homeTeamId: m.homeTeamId,
  awayTeamId: m.awayTeamId,
  homeScore: m.homeScore,
  awayScore: m.awayScore
});

/** Who won; a tied playoff game goes to the better seed, who is always home. */
const winnerOf = (home: number | null, away: number | null, playoff: boolean) => {
  if (home === null || away === null) return null;
  const winner = matchupResult(home, away).winner;
  return winner === null && playoff ? 'home' : winner;
};

export async function finalizeOfficialWeek(
  deps: OfficialDeps,
  league: League,
  week: number,
  now: Date
): Promise<OfficialOutcome> {
  const skip = (reason: string): OfficialOutcome => ({
    leagueId: league.id,
    week,
    status: 'skipped',
    reason
  });
  const stored = await deps.repos.schedule.listMatchups(league.id, week);
  if (stored.length === 0 || stored.some((m) => m.status !== 'final')) return skip('week_not_final');
  const claim = await deps.repos.history.beginOfficialWeek(
    {
      leagueId: league.id,
      week,
      status: 'running',
      startedAt: now.toISOString(),
      completedAt: null,
      provisional: stored.map(snapshot),
      corrections: 0,
      flipped: 0
    },
    new Date(now.getTime() - OFFICIAL_CLAIM_STALE_MS).toISOString()
  );
  if (claim === null) return skip('already_official');

  // After the week every starter has kicked off, so each is scored from the lineup as played
  // (frozen at his kickoff), not from today's roster, which waivers may have changed since.
  const scores = await scoreWeek(deps, league, week, now);
  const before = new Map(claim.provisional.map((p) => [p.matchupId, p]));
  const scoreOf = (teamId: string) => scores.get(teamId)?.points ?? 0;
  const rescored = stored.map((m) => ({
    ...m,
    homeScore: scoreOf(m.homeTeamId),
    awayScore: scoreOf(m.awayTeamId)
  }));
  await deps.repos.schedule.putMatchups(rescored);
  const corrections = rescored.flatMap((m) => {
    const old = before.get(m.id) ?? snapshot(m);
    if (old.homeScore === m.homeScore && old.awayScore === m.awayScore) return [];
    const playoff = m.kind === 'playoff';
    const flipped =
      winnerOf(old.homeScore, old.awayScore, playoff) !== winnerOf(m.homeScore, m.awayScore, playoff);
    return [{ matchup: m, old, flipped }];
  });

  const regular = stored.some((m) => m.kind === 'regular');
  if (corrections.length > 0) await applyCorrections(deps, league, week, regular, now);

  const games = playedGames(rescored);
  const awards = weekAchievements(week, games);
  if (league.phase === 'complete' && week === league.week) {
    const [playoffs, all] = await Promise.all([
      deps.repos.history.getPlayoffs(league.id),
      deps.repos.schedule.listMatchups(league.id)
    ]);
    awards.push(
      ...seasonAchievements({
        championTeamId: playoffs?.championTeamId ?? null,
        consolationChampionTeamId: playoffs?.consolationChampionTeamId ?? null,
        games: playedGames(all)
      })
    );
  }

  const flipped = corrections.filter((c) => c.flipped).length;
  for (const { matchup, old, flipped: isFlip } of corrections) {
    const home = matchup.homeScore;
    const away = matchup.awayScore;
    const homeSide = Math.abs(home - Number(old.homeScore)) >= Math.abs(away - Number(old.awayScore));
    await deps.events.publish('Stat Correction Applied', {
      leagueId: league.id,
      season: league.season,
      week,
      matchupId: matchup.id,
      teamId: homeSide ? matchup.homeTeamId : matchup.awayTeamId,
      oldScore: homeSide ? old.homeScore : old.awayScore,
      newScore: homeSide ? matchup.homeScore : matchup.awayScore,
      before: { homeScore: old.homeScore, awayScore: old.awayScore },
      after: scoreLine(matchup),
      resultFlipped: isFlip,
      winnerTeamId: home >= away ? matchup.homeTeamId : matchup.awayTeamId,
      loserTeamId: home >= away ? matchup.awayTeamId : matchup.homeTeamId,
      winnerScore: Math.max(home, away),
      loserScore: Math.min(home, away)
    });
  }
  await deps.events.publish('Week Official Final', {
    leagueId: league.id,
    season: league.season,
    week,
    corrections: corrections.length,
    flipped,
    recap:
      corrections.length === 0
        ? 'No stat corrections changed a score.'
        : `Stat corrections changed ${corrections.length} matchup(s)${flipped > 0 ? `, and ${flipped} result(s) flipped` : ''}.`,
    matchups: rescored.map(scoreLine),
    officialAt: now.toISOString()
  });
  await awardAchievements(deps, league, awards, now);
  const done: OfficialWeekRecord = {
    ...claim,
    status: 'complete',
    completedAt: now.toISOString(),
    corrections: corrections.length,
    flipped
  };
  await deps.repos.history.completeOfficialWeek(done);
  return { leagueId: league.id, week, status: 'official', corrections: corrections.length, flipped };
}

/**
 * Carries corrected scores forward: standings from the corrected week to the latest snapshot, and
 * the bracket (seeding from the final regular-season week, or who advanced from a playoff week),
 * with the current playoff week's games rewritten when their teams changed and the season archive
 * updated once the league is complete.
 */
async function applyCorrections(
  deps: OfficialDeps,
  league: League,
  week: number,
  regular: boolean,
  now: Date
): Promise<void> {
  if (regular) {
    const latest = await deps.repos.schedule.latestStandings(league.id);
    for (let w = week; latest !== null && w <= latest.week; w++) await recordStandings(deps, league, w, now);
  }
  const affectsBracket = !regular || week === league.settings.schedule.regularSeasonEndWeek;
  if (!affectsBracket || league.phase === 'regular_season') return;
  const playoffs = await rebuildPlayoffs(deps, league, now);
  if (playoffs === null) return;
  if (league.phase === 'playoffs' && league.week !== null) {
    await writePlayoffGames(deps, league, playoffs.bracket, league.week);
  }
  if (league.phase === 'complete') await recordSeasonHistory(deps, league, playoffs, now);
}
