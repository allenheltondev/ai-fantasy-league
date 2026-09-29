/**
 * Normalized data types. Every consumer (server, agents, sim) sees these shapes, never the raw
 * Sleeper or nflverse payloads. Team codes are Sleeper's (`LAR`, not nflverse's `LA`).
 */

import type { ScoringPlayKind } from '@fantasy/core';

/** Sleeper stat key, for example `pass_yd`, `rec`, `pts_half_ppr`. */
export type StatKey = string;

export type StatMap = Record<StatKey, number>;

export type SeasonType = 'pre' | 'regular' | 'post' | 'off';

export type InjuryStatus = 'Questionable' | 'Doubtful' | 'Out' | 'IR' | 'PUP' | 'Suspended' | 'NA' | 'Other';

export interface Player {
  /** Sleeper player id. Team defenses use the team code (`KC`). */
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  /** Sleeper team code, or null for free agents. */
  team: string | null;
  /** Primary position (`QB`, `RB`, `WR`, `TE`, `K`, `DEF`, IDP positions...). */
  position: string | null;
  fantasyPositions: string[];
  /** Roster status as Sleeper reports it (`Active`, `Inactive`, `Injured Reserve`, ...). */
  status: string | null;
  injuryStatus: InjuryStatus | null;
  /** Raw injury status text when it did not map to a known value. */
  injuryStatusRaw?: string;
  depthChartOrder: number | null;
  depthChartPosition: string | null;
  active: boolean;
  byeWeek?: number;
  /** nflverse / NFL GSIS id (`00-0033873`). */
  gsisId?: string;
  /** ESPN's athlete id (Sleeper's `espn_id`), which maps ESPN's injury report to our players (#200). */
  espnId?: string;
  age?: number;
  yearsExp?: number;
  number?: number;
  /** Sleeper's consensus rank (lower is better). Absent when unranked. */
  searchRank?: number;
  /** Lowercase, punctuation-free names used to resolve a player from free text. */
  searchNames: string[];
}

export interface NflState {
  season: number;
  seasonType: SeasonType;
  /** The current NFL week (Sleeper's `week`). */
  week: number;
  /** The week clients should display (Sleeper's `display_week`). */
  displayWeek: number;
  leagueSeason: number;
  previousSeason: number;
  /** ISO date (YYYY-MM-DD) of the regular season's first game when known. */
  seasonStartDate: string | null;
}

export interface StatLine {
  playerId: string;
  season: number;
  week: number;
  /** Team the player played for in that game when the source knows it. */
  team?: string;
  stats: StatMap;
}

export type ProjectionLine = StatLine;

export type TrendingType = 'add' | 'drop';

export interface TrendingEntry {
  playerId: string;
  count: number;
}

export type GameStatus = 'scheduled' | 'final';

export interface ScheduledGame {
  /** nflverse game id, for example `2025_01_DAL_PHI`. */
  gameId: string;
  season: number;
  seasonType: 'regular' | 'post';
  week: number;
  /** Kickoff in UTC, ISO 8601. */
  kickoff: string;
  homeTeam: string;
  awayTeam: string;
  status: GameStatus;
  homeScore?: number;
  awayScore?: number;
}

/** ESPN's game state: before kickoff, in progress, or over. */
export type GameState = 'pre' | 'in' | 'post';

/**
 * One NFL game as it stands (ESPN's scoreboard): score, status and clock, and while it is in
 * progress who has the ball and where. Team codes are Sleeper's. Only an in-progress game with a
 * known possession can be in the red zone.
 */
export interface LiveGame {
  /** Our schedule's `gameId` for this game, or null when the schedule has no matching game. */
  gameKey: string | null;
  /** ESPN's event id. */
  espnId: string;
  homeTeam: string | null;
  awayTeam: string | null;
  /** Null before kickoff. */
  homeScore: number | null;
  awayScore: number | null;
  /** Kickoff in UTC, ISO 8601, or null when ESPN leaves it out. */
  kickoff: string | null;
  state: GameState;
  /** ESPN's short status, for example `8:32 - 2nd`, `Final`, or `10/4 - 4:25 PM EDT`. */
  status: string | null;
  /** The quarter (5 and up is overtime), or null before kickoff. */
  period: number | null;
  /** The game clock (`8:32`) while in progress, else null. */
  clock: string | null;
  /** The team with the ball, or null (not in progress, a change of possession, or unknown). */
  possessionTeam: string | null;
  /** The team with the ball is inside the opponent's 20-yard line. */
  isRedZone: boolean;
  /** Down, distance, and spot, for example `2nd & 4 at DAL 7`, or null. */
  downDistance: string | null;
  /** The spot of the ball, for example `DAL 7` (or `50`), or null. */
  fieldPosition: string | null;
  /** Yards from the ball to the end zone the offense is attacking (0-100), or null. */
  yardsToGoal: number | null;
  /** When the game was read (the caller's `asOf`). */
  updatedAt: string;
}

/**
 * One scoring play from ESPN's game summary (#164): its description, kind, when in the game, the
 * scoring team (Sleeper's code), and the score after it. Everything but the id, kind, and text may
 * be null when ESPN leaves it out.
 */
export interface ScoringPlay {
  /** ESPN's play id, unique within a game. */
  id: string;
  kind: ScoringPlayKind;
  /** ESPN's play type, e.g. "Passing Touchdown", or null. */
  typeText: string | null;
  /** "Travis Kelce 18 Yd pass from Patrick Mahomes (Harrison Butker Kick)". */
  text: string;
  period: number | null;
  /** The game clock at the play, e.g. "8:32", or null. */
  clock: string | null;
  team: string | null;
  awayScore: number | null;
  homeScore: number | null;
}

/**
 * One player's line on ESPN's injury report (#200). `injuryStatus` is his designation in our terms
 * (null: ESPN lists him as active or probable, so no designation); `statusText` is ESPN's own word.
 * Team codes are Sleeper's.
 */
export interface InjuryReport {
  espnId: string | null;
  name: string;
  team: string | null;
  position: string | null;
  injuryStatus: InjuryStatus | null;
  statusText: string;
  /** When ESPN last updated the entry, or null. */
  reportedAt: string | null;
  comment: string | null;
}

/** Bye week per team code for one regular season. */
export type ByeWeeks = Record<string, number>;

/** One week of a player's season (stats or a projection), compacted to the scoring stat keys. */
export interface SeasonWeekLine {
  week: number;
  stats: StatMap;
}

/**
 * A player's whole regular season in one record: last season's weekly stats, or this season's
 * weekly projections. Scored per league at read time (`seasonPoints` in `@fantasy/core`).
 */
export interface PlayerSeasonLines {
  playerId: string;
  season: number;
  /** The team on his latest line, when the source knew it. */
  team?: string;
  /** Weeks with a line, in week order. */
  weeks: SeasonWeekLine[];
}
