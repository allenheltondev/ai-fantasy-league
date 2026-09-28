import type { PlayedGame } from './records.js';

/**
 * League achievements (#82): what a team can earn and when. Awards are computed here from final
 * results; the server stores them per league (people and agents alike) and, for people, reports the
 * matching rsc-core badge chest activity (`badgeAction`, a stable metric name the badge catalog
 * keys on).
 */

export const ACHIEVEMENT_IDS = [
  'league-champion',
  'consolation-champion',
  'weekly-high-score',
  'blowout-win',
  'season-high-score'
] as const;
export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];

export interface AchievementDefinition {
  id: AchievementId;
  name: string;
  description: string;
  /** The rsc-core `Track Activity` action (`noun.verb`, dot-namespaced, stable). */
  badgeAction: string;
}

/** Margin of victory that counts as a blowout. */
export const BLOWOUT_MARGIN = 50;

export const ACHIEVEMENTS: Readonly<Record<AchievementId, AchievementDefinition>> = {
  'league-champion': {
    id: 'league-champion',
    name: 'League Champion',
    description: 'Won the championship game.',
    badgeAction: 'fantasy.championship.won'
  },
  'consolation-champion': {
    id: 'consolation-champion',
    name: 'Consolation Champion',
    description: 'Won the consolation bracket.',
    badgeAction: 'fantasy.consolation.won'
  },
  'weekly-high-score': {
    id: 'weekly-high-score',
    name: 'Top Score of the Week',
    description: 'Scored the most points in the league in a week.',
    badgeAction: 'fantasy.week.high_score'
  },
  'blowout-win': {
    id: 'blowout-win',
    name: 'Blowout',
    description: `Won a matchup by ${BLOWOUT_MARGIN} or more points.`,
    badgeAction: 'fantasy.blowout.won'
  },
  'season-high-score': {
    id: 'season-high-score',
    name: 'Record Setter',
    description: 'Posted the highest single-week score of the season.',
    badgeAction: 'fantasy.season.high_score'
  }
};

export interface AchievementAward {
  achievementId: AchievementId;
  teamId: string;
  /** The week it was earned in, or null for a season award. */
  week: number | null;
  /** What earned it, e.g. "142.5 points in week 3". */
  reason: string;
}

const points = (n: number) => String(Math.round(n * 100) / 100);

/** A week's awards: the top score (every team tied for it) and each blowout win. */
export function weekAchievements(week: number, games: readonly PlayedGame[]): AchievementAward[] {
  const played = games.filter((g) => g.week === week);
  if (played.length === 0) return [];
  const scores = played.flatMap((g) => [
    { teamId: g.homeTeamId, points: g.homeScore },
    { teamId: g.awayTeamId, points: g.awayScore }
  ]);
  const top = Math.max(...scores.map((s) => s.points));
  const awards: AchievementAward[] = [];
  if (top > 0) {
    for (const s of scores.filter((x) => x.points === top).sort((a, b) => a.teamId.localeCompare(b.teamId))) {
      awards.push({
        achievementId: 'weekly-high-score',
        teamId: s.teamId,
        week,
        reason: `${points(s.points)} points, the most in week ${week}`
      });
    }
  }
  for (const g of played) {
    const margin = Math.abs(g.homeScore - g.awayScore);
    if (margin < BLOWOUT_MARGIN) continue;
    const homeWon = g.homeScore > g.awayScore;
    awards.push({
      achievementId: 'blowout-win',
      teamId: homeWon ? g.homeTeamId : g.awayTeamId,
      week,
      reason: `Won by ${points(margin)} in week ${week}`
    });
  }
  return awards;
}

export interface SeasonAchievementInput {
  championTeamId: string | null;
  consolationChampionTeamId: string | null;
  /** Every final game of the season. */
  games: readonly PlayedGame[];
}

/** Awards decided at the end of the season: the champions and the season's top single-week score. */
export function seasonAchievements(input: SeasonAchievementInput): AchievementAward[] {
  const awards: AchievementAward[] = [];
  if (input.championTeamId !== null) {
    awards.push({
      achievementId: 'league-champion',
      teamId: input.championTeamId,
      week: null,
      reason: 'Won the championship'
    });
  }
  if (input.consolationChampionTeamId !== null) {
    awards.push({
      achievementId: 'consolation-champion',
      teamId: input.consolationChampionTeamId,
      week: null,
      reason: 'Won the consolation bracket'
    });
  }
  const scores = input.games.flatMap((g) => [
    { teamId: g.homeTeamId, week: g.week, points: g.homeScore },
    { teamId: g.awayTeamId, week: g.week, points: g.awayScore }
  ]);
  if (scores.length > 0) {
    const top = Math.max(...scores.map((s) => s.points));
    const first = scores
      .filter((s) => s.points === top)
      .sort((a, b) => a.week - b.week || a.teamId.localeCompare(b.teamId))[0];
    if (first !== undefined && top > 0) {
      awards.push({
        achievementId: 'season-high-score',
        teamId: first.teamId,
        week: null,
        reason: `${points(top)} points in week ${first.week}, the season high`
      });
    }
  }
  return awards;
}
