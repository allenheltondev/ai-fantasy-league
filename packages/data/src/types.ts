/**
 * Normalized data types. Every consumer (server, agents, sim) sees these shapes, never the raw
 * Sleeper or nflverse payloads. Team codes are Sleeper's (`LAR`, not nflverse's `LA`).
 */

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

/** Bye week per team code for one regular season. */
export type ByeWeeks = Record<string, number>;
