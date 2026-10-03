import {
  playedWeek,
  scorePlayer,
  seasonPoints,
  statLabel,
  type ScoreBreakdownItem,
  type ScoringSettings,
  type WeekPoints,
  USAGE_STAT_PREFIX
} from '@fantasy/core';
import type { Ctx } from '../context.js';
import type { Player } from './model.js';
import { cardTotals } from './research.js';

/**
 * A player's current form for the player card: this season's production so far (week by week,
 * totals, points per game) and his projection for the upcoming week with its matchup. Scored under
 * the caller's scoring, from the stored stat lines (`STATS#…`), projection snapshots, and the NFL
 * schedule, so it is always as current as the ingestion jobs.
 */

/** Regular-season weeks only: the postseason is not part of a fantasy season's stats. */
const LAST_REGULAR_WEEK = 18;

/** One line of a game's scoring: what he did and the points it earned ("82 rec yds", 8.2). */
export interface GameScoreLine {
  stat: string;
  text: string;
  points: number;
}

/** One of his last games in detail: the points, how they compare with his average, and where they came from. */
export interface RecentGame {
  week: number;
  points: number;
  /** Points above (+) or below (-) his points per game this season. */
  vsAverage: number;
  opponent: { team: string; home: boolean } | null;
  /** Where the points came from, biggest first and penalties last; the small rest is `other`. */
  breakdown: GameScoreLine[];
}

export interface ThisSeason {
  season: number;
  points: number;
  ppg: number;
  games: number;
  weekly: WeekPoints[];
  totals: Record<string, number>;
  /** His last three games played, newest first. */
  recent: RecentGame[];
  /** His usage from nflverse's official weekly stats; null before any official week. */
  usage: SeasonUsage | null;
}

/**
 * A player's usage this season from the nflverse numbers the Thursday official final adds to each
 * week's stat line (`nfv_…`, `NFLVERSE_USAGE` in `@fantasy/data`). Only official weeks have them,
 * so `games` and `throughWeek` can trail his games played. Each figure is null when no counted game
 * reported it (a quarterback has no target share worth showing, a receiver no passing EPA).
 */
export interface SeasonUsage {
  /** Official games counted. */
  games: number;
  /** The last official week counted. */
  throughWeek: number;
  /** Average share of his team's targets (0.25 is a quarter). */
  targetShare: number | null;
  /** Average share of his team's air yards. */
  airYardsShare: number | null;
  /** Weighted opportunity rating: 1.5 × target share + 0.7 × air yards share. */
  wopr: number | null;
  /** Average depth of target: air yards per target. */
  aDot: number | null;
  /** Yards after the catch per reception. */
  yacPerReception: number | null;
  /** Expected points added per game, by how he gained them. */
  receivingEpa: number | null;
  rushingEpa: number | null;
  passingEpa: number | null;
  /** Completion percentage over expected, weighted by attempts. */
  cpoe: number | null;
  /** Air yards per pass attempt. */
  passingAdot: number | null;
}

const RECEIVER_SHARE = `${USAGE_STAT_PREFIX}tgt_share`;
const usageKey = (name: string) => `${USAGE_STAT_PREFIX}${name}`;

/** His usage over the official weeks among `played` (those carrying nflverse's numbers). */
export function seasonUsage(
  played: readonly { week: number; stats: Record<string, number> }[]
): SeasonUsage | null {
  const games = played.filter((p) => playedWeek(p.stats) && p.stats[RECEIVER_SHARE] !== undefined);
  if (games.length === 0) return null;
  const sum = (key: string) => games.reduce((total, g) => total + (g.stats[key] ?? 0), 0);
  const reported = (key: string) => games.filter((g) => g.stats[key] !== undefined);
  const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
  const average = (key: string, places: number) => round(sum(key) / games.length, places);
  const perGame = (name: string) =>
    reported(usageKey(name)).length === 0 ? null : round(sum(usageKey(name)) / games.length, 2);
  const ratio = (top: number, bottom: number, places: number) =>
    bottom > 0 ? round(top / bottom, places) : null;
  const targets = sum('rec_tgt');
  const attempts = sum('pass_att');
  const cpoeGames = reported(usageKey('pass_cpoe'));
  const cpoeAttempts = cpoeGames.reduce((total, g) => total + (g.stats.pass_att ?? 0), 0);
  return {
    games: games.length,
    throughWeek: Math.max(...games.map((g) => g.week)),
    targetShare: targets > 0 ? average(RECEIVER_SHARE, 3) : null,
    airYardsShare: targets > 0 ? average(usageKey('air_yd_share'), 3) : null,
    wopr: targets > 0 ? average(usageKey('wopr'), 3) : null,
    aDot: ratio(sum(usageKey('rec_air_yd')), targets, 1),
    yacPerReception: ratio(sum(usageKey('rec_yac')), sum('rec'), 1),
    receivingEpa: perGame('rec_epa'),
    rushingEpa: perGame('rush_epa'),
    passingEpa: perGame('pass_epa'),
    cpoe: ratio(
      cpoeGames.reduce(
        (total, g) => total + (g.stats[usageKey('pass_cpoe')] ?? 0) * (g.stats.pass_att ?? 0),
        0
      ),
      cpoeAttempts,
      1
    ),
    passingAdot: ratio(sum(usageKey('pass_air_yd')), attempts, 1)
  };
}

/** Games shown in the recent-games detail. */
export const RECENT_GAMES = 3;
/** Scoring lines shown per game; the rest fold into one `other` line. */
const BREAKDOWN_LINES = 5;

const round1 = (n: number) => Math.round(n * 10) / 10;

function lineText(item: ScoreBreakdownItem): string {
  return item.tier === undefined
    ? `${round1(item.value)} ${statLabel(item.stat, item.value)}`
    : `${statLabel(item.stat, item.value)} bonus`;
}

/** A game's scoring as lines: the biggest earners first, penalties last, the small rest as `other`. */
export function gameBreakdown(items: readonly ScoreBreakdownItem[]): GameScoreLine[] {
  const ordered = [...items]
    .filter((i) => i.points !== 0)
    .sort((a, b) => Math.sign(b.points) - Math.sign(a.points) || Math.abs(b.points) - Math.abs(a.points));
  const lines = ordered.slice(0, BREAKDOWN_LINES).map((i) => ({
    stat: i.stat,
    text: lineText(i),
    points: i.points
  }));
  const rest = ordered.slice(BREAKDOWN_LINES);
  return rest.length === 0
    ? lines
    : [
        ...lines,
        {
          stat: 'other',
          text: 'other',
          points: Math.round(rest.reduce((sum, i) => sum + i.points, 0) * 100) / 100
        }
      ];
}

export interface NextWeek {
  season: number;
  week: number;
  /** Projected points under the caller's scoring, or null when no projection is published yet. */
  points: number | null;
  /** Projected stat totals for his position; empty when unprojected. */
  totals: Record<string, number>;
  /** True when his NFL team has no game that week. */
  bye: boolean;
  opponent: { team: string; home: boolean } | null;
  kickoff: string | null;
}

export interface CurrentForm {
  thisSeason: ThisSeason | null;
  nextWeek: NextWeek | null;
}

/**
 * The season and week the card calls current: during the regular season, the NFL's current week
 * (the one being played, or about to be); in the preseason, week 1 of the coming season. Null in
 * the offseason, and when the NFL state has not been synced.
 */
export function currentWeek(
  state: { season: number; seasonType: string; week: number; leagueSeason: number } | null
): {
  season: number;
  week: number;
} | null {
  if (state === null) return null;
  if (state.seasonType === 'regular')
    return { season: state.season, week: Math.min(Math.max(state.week, 1), LAST_REGULAR_WEEK) };
  if (state.seasonType === 'pre') return { season: Math.max(state.season, state.leagueSeason), week: 1 };
  return null;
}

export async function loadCurrentForm(
  ctx: Pick<Ctx, 'data' | 'clock'>,
  scoring: ScoringSettings,
  player: Player
): Promise<CurrentForm> {
  const reference = ctx.data.reference;
  const state = await reference.nflState.get();
  const current = currentWeek(state);
  if (current === null) return { thisSeason: null, nextWeek: null };
  const { season, week } = current;

  const [history, research, snapshot, games] = await Promise.all([
    reference.stats.getPlayerHistory(player.id, season),
    reference.seasons.get('stats', season, [player.id]),
    reference.projections.latestSnapshot(season, week, ctx.clock.now()),
    reference.schedule.getWeek(season, week)
  ]);

  // Completed weeks come from the research set (every week, even one the live job missed); the
  // live stat lines win where both have a week, since they are fresher during a game.
  const byWeek = new Map<number, Record<string, number>>();
  for (const w of research[0]?.weeks ?? []) byWeek.set(w.week, w.stats as Record<string, number>);
  for (const l of history) if (l.season === season) byWeek.set(l.week, l.stats as Record<string, number>);
  const played = [...byWeek]
    .filter(([week]) => week >= 1 && week <= LAST_REGULAR_WEEK)
    .sort(([a], [b]) => a - b)
    .map(([week, stats]) => ({ week, stats }));
  let thisSeason: ThisSeason | null = null;
  if (played.length > 0) {
    const scored = seasonPoints(scoring, played);
    const lastGames = played.filter((p) => playedWeek(p.stats)).slice(-RECENT_GAMES);
    const opponents = await Promise.all(lastGames.map((g) => reference.schedule.getWeek(season, g.week)));
    const recent = lastGames
      .map((g, i): RecentGame => {
        const result = scorePlayer(scoring, g.stats);
        return {
          week: g.week,
          points: result.points,
          vsAverage: round1(result.points - scored.ppg),
          opponent: opponentIn(opponents[i] ?? [], player.team),
          breakdown: gameBreakdown(result.breakdown)
        };
      })
      .reverse();
    thisSeason = {
      season,
      points: scored.points,
      ppg: scored.ppg,
      games: scored.games,
      weekly: scored.weekly,
      totals: cardTotals({ playerId: player.id, season, weeks: played }, player.position),
      recent,
      usage: seasonUsage(played)
    };
  }

  const [line] = snapshot === null ? [] : await reference.projections.getLines(snapshot, [player.id]);
  const projected = line === undefined ? null : [{ week, stats: line.stats }];
  const game =
    player.team === null
      ? undefined
      : games.find((g) => g.homeTeam === player.team || g.awayTeam === player.team);
  const nextWeek: NextWeek = {
    season,
    week,
    points: projected === null ? null : seasonPoints(scoring, projected).points,
    totals:
      projected === null
        ? {}
        : cardTotals({ playerId: player.id, season, weeks: projected }, player.position),
    // No game this week means a bye, once the week's schedule is known.
    bye: games.length > 0 && game === undefined,
    opponent: opponentIn(games, player.team),
    kickoff: game?.kickoff ?? null
  };
  return { thisSeason, nextWeek };
}

/** Who his team played in a week's games, or null when it did not (or he has no team). */
function opponentIn(
  games: readonly { homeTeam: string; awayTeam: string }[],
  team: string | null
): { team: string; home: boolean } | null {
  if (team === null) return null;
  const game = games.find((g) => g.homeTeam === team || g.awayTeam === team);
  if (game === undefined) return null;
  return game.homeTeam === team ? { team: game.awayTeam, home: true } : { team: game.homeTeam, home: false };
}
