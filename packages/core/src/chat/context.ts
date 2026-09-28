import type { HeadToHeadRecord, PlayedGame } from '../history/records.js';

/**
 * Pure helpers for the chat context packs (issue #153): the facts an AI manager gets about the room
 * it talks in. The server assembles the packs from league data; these are the pieces with rules.
 */

export interface PowerRanking {
  rank: number;
  teamId: string;
  /** Higher is better: win percentage, points per game, and recent form together. */
  score: number;
}

/** Games of recent form counted by `powerRankings`. */
export const POWER_FORM_GAMES = 3;

const round1 = (x: number) => Math.round(x * 10) / 10;
const gameKey = (g: PlayedGame) => `${g.homeTeamId}|${g.awayTeamId}|${g.homeScore}|${g.awayScore}`;

/**
 * Power rankings from the season's regular-season games: 40 points of win percentage, plus points
 * per game, plus half the average of the last `POWER_FORM_GAMES` games (hot teams climb). Teams
 * with no game yet score 0. Ties go to the team id, so the order never depends on input order.
 */
export function powerRankings(games: readonly PlayedGame[], teamIds: readonly string[]): PowerRanking[] {
  const scores = [...new Set(teamIds)].map((teamId) => {
    const mine = games
      .filter((g) => g.kind === 'regular' && (g.homeTeamId === teamId || g.awayTeamId === teamId))
      // By week; a week with two games (never in a real schedule) orders them by content.
      .sort((a, b) => a.week - b.week || gameKey(a).localeCompare(gameKey(b)))
      .map((g) => {
        const home = g.homeTeamId === teamId;
        const pointsFor = home ? g.homeScore : g.awayScore;
        const against = home ? g.awayScore : g.homeScore;
        return { pointsFor, result: pointsFor > against ? 1 : pointsFor < against ? 0 : 0.5 };
      });
    if (mine.length === 0) return { teamId, score: 0 };
    const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const winPct = avg(mine.map((g) => g.result));
    const ppg = avg(mine.map((g) => g.pointsFor));
    const form = avg(mine.slice(-POWER_FORM_GAMES).map((g) => g.pointsFor));
    return { teamId, score: round1(40 * winPct + ppg + form / 2) };
  });
  return scores
    .sort((a, b) => b.score - a.score || a.teamId.localeCompare(b.teamId))
    .map((s, i) => ({ rank: i + 1, ...s }));
}

export interface SeriesRecord {
  wins: number;
  losses: number;
  ties: number;
}

/** The head-to-head record between two teams from `teamId`'s side, or null when they never met. */
export function seriesBetween(
  records: readonly HeadToHeadRecord[],
  teamId: string,
  opponentId: string
): SeriesRecord | null {
  for (const r of records) {
    if (r.teamId === teamId && r.opponentId === opponentId)
      return { wins: r.wins, losses: r.losses, ties: r.ties };
    if (r.teamId === opponentId && r.opponentId === teamId)
      return { wins: r.losses, losses: r.wins, ties: r.ties };
  }
  return null;
}

/** "3-1" or "3-1-1". */
export function formatSeries(s: SeriesRecord): string {
  return s.ties > 0 ? `${s.wins}-${s.losses}-${s.ties}` : `${s.wins}-${s.losses}`;
}

/**
 * Whole lines, in order, while their text (joined by newlines) fits in `maxChars`: a fact pack is
 * cut at a line, never mid-fact. Lines after the first that does not fit are dropped too.
 */
export function fitLines(lines: readonly string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length === 0 ? 0 : 1);
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  return kept;
}
