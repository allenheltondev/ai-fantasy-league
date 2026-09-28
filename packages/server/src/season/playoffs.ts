import {
  champion,
  consolationChampion,
  headToHead,
  playoffBracket,
  seasonRecords,
  type Bracket,
  type BracketWeekResults,
  type PlayedGame
} from '@fantasy/core';
import { weekKey } from '../repos/dynamo/query.js';
import type { PlayoffGameResult, PlayoffRecord, SeasonHistoryRecord } from '../repos/history.js';
import type { League, Matchup } from '../repos/types.js';
import type { SeasonDeps } from './lineups.js';

/**
 * Playoffs (#78) and the season archive (#81). The bracket is rebuilt from the final
 * regular-season standings and the final playoff matchups every time it changes (a week ends, or a
 * stat correction flips a result), then stored for reads. Each bracket game is played as a
 * `playoff` matchup whose id carries the game id, so rewriting a game's teams (a correction that
 * changes who advanced) overwrites the same matchup.
 */

/** The matchup id of a bracket game: `W16-P-championship-r2-g1`. */
export const playoffMatchupId = (week: number, gameId: string) => `${weekKey(week)}-P-${gameId}`;

/** Final playoff matchups as bracket results, per week. */
function playedWeeks(matchups: readonly Matchup[]): BracketWeekResults[] {
  const games = playedGames(matchups).filter((g) => g.kind === 'playoff');
  return [...new Set(games.map((g) => g.week))].map((week) => ({
    week,
    results: games.filter((g) => g.week === week)
  }));
}

/**
 * Rebuilds and stores the league's bracket. Null (with a warning logged) when there are no final
 * regular-season standings yet or the bracket cannot be built from them.
 */
export async function rebuildPlayoffs(
  deps: Pick<SeasonDeps, 'repos' | 'log'>,
  league: League,
  now: Date
): Promise<PlayoffRecord | null> {
  const [standings, matchups] = await Promise.all([
    deps.repos.schedule.latestStandings(league.id),
    deps.repos.schedule.listMatchups(league.id)
  ]);
  if (standings === null) return null;
  const bracket = playoffBracket(league.settings, standings.rows, playedWeeks(matchups));
  if (!bracket.ok) {
    deps.log.warn('could not build the playoff bracket', { leagueId: league.id, issues: bracket.issues });
    return null;
  }
  const record: PlayoffRecord = {
    leagueId: league.id,
    season: league.season,
    seedingWeek: standings.week,
    bracket: bracket.value,
    championTeamId: champion(bracket.value),
    consolationChampionTeamId: consolationChampion(bracket.value),
    updatedAt: now.toISOString()
  };
  await deps.repos.history.putPlayoffs(record);
  return record;
}

/**
 * Writes the bracket games of playoff `week` whose teams are known. A game already stored with the
 * same teams is left alone (it may be live); one whose teams changed is rewritten unscored. Teams
 * without a game that week (byes, eliminated teams) get no matchup.
 */
export async function writePlayoffGames(
  deps: Pick<SeasonDeps, 'repos'>,
  league: League,
  bracket: Bracket,
  week: number
): Promise<Matchup[]> {
  const stored = new Map((await deps.repos.schedule.listMatchups(league.id, week)).map((m) => [m.id, m]));
  const games: Matchup[] = [];
  for (const g of bracket.games) {
    if (g.week !== week || g.home.teamId === null || g.away.teamId === null) continue;
    const id = playoffMatchupId(week, g.id);
    const existing = stored.get(id);
    if (existing?.homeTeamId === g.home.teamId && existing.awayTeamId === g.away.teamId) continue;
    games.push({
      id,
      leagueId: league.id,
      week,
      kind: 'playoff',
      homeTeamId: g.home.teamId,
      awayTeamId: g.away.teamId,
      homeScore: null,
      awayScore: null,
      status: 'scheduled'
    });
  }
  await deps.repos.schedule.putMatchups(games);
  return games;
}

/** Every final game of the season, for records and achievements. */
export function playedGames(matchups: readonly Matchup[]): PlayedGame[] {
  return matchups.flatMap((m) =>
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
  );
}

function playoffResults(bracket: Bracket): PlayoffGameResult[] {
  return bracket.games.map((g) => ({
    gameId: g.id,
    bracket: g.bracket,
    round: g.round,
    week: g.week,
    homeTeamId: g.home.teamId,
    awayTeamId: g.away.teamId,
    homeSeed: g.home.seed,
    awaySeed: g.away.seed,
    homeScore: g.home.score,
    awayScore: g.away.score,
    winnerTeamId: g.winnerTeamId
  }));
}

/**
 * Archives the season once the league is complete: champion and runner-up, final standings,
 * playoff results, records, and head-to-head. Written again when a stat correction changes it.
 */
export async function recordSeasonHistory(
  deps: Pick<SeasonDeps, 'repos'>,
  league: League,
  playoffs: PlayoffRecord | null,
  now: Date
): Promise<SeasonHistoryRecord> {
  const [standings, matchups, teams, previous] = await Promise.all([
    deps.repos.schedule.latestStandings(league.id),
    deps.repos.schedule.listMatchups(league.id),
    deps.repos.teams.list(league.id),
    deps.repos.history.listSeasons(league.id)
  ]);
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const games = playedGames(matchups);
  const final = playoffs?.bracket.games.find((g) => g.id === playoffs.bracket.finalGameId);
  const runnerUp =
    final?.winnerTeamId == null
      ? null
      : final.home.teamId === final.winnerTeamId
        ? final.away.teamId
        : final.home.teamId;
  const record: SeasonHistoryRecord = {
    leagueId: league.id,
    season: league.season,
    leagueName: league.name,
    championTeamId: playoffs?.championTeamId ?? null,
    runnerUpTeamId: runnerUp,
    consolationChampionTeamId: playoffs?.consolationChampionTeamId ?? null,
    finalStandings: (standings?.rows ?? []).map((r) => ({
      rank: r.rank,
      teamId: r.teamId,
      teamName: names.get(r.teamId) ?? r.teamId,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      pointsFor: r.pointsFor,
      pointsAgainst: r.pointsAgainst
    })),
    playoffResults: playoffs === null ? [] : playoffResults(playoffs.bracket),
    records: seasonRecords(games),
    headToHead: headToHead(games),
    completedAt: previous.find((s) => s.season === league.season)?.completedAt ?? now.toISOString(),
    updatedAt: now.toISOString()
  };
  await deps.repos.history.putSeason(record);
  return record;
}
