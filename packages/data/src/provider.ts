import type { IdCrosswalk } from './nflverse/crosswalk.js';
import type { ProjectionSource } from './sleeper/client.js';
import type {
  ByeWeeks,
  LiveGame,
  NflState,
  Player,
  ProjectionLine,
  ScheduledGame,
  ScoringPlay,
  StatLine,
  TrendingEntry,
  TrendingType
} from './types.js';

export interface TrendingOptions {
  /** Hours to look back (Sleeper default 24). */
  lookbackHours?: number;
  /** Max entries (Sleeper default 25). */
  limit?: number;
}

/**
 * The only way consumers read external football data.
 *
 * Every method takes `asOf`: the moment the caller is "living in". Live providers serve the
 * latest data (they cannot see the future either), while historical providers use `asOf` to hide
 * anything that would not have been known yet, so the replay simulator cannot peek ahead.
 */
export interface DataProvider {
  getPlayers(asOf: Date): Promise<Player[]>;
  getNflState(asOf: Date): Promise<NflState>;
  getWeekStats(season: number, week: number, asOf: Date): Promise<StatLine[]>;
  getWeekProjections(season: number, week: number, asOf: Date): Promise<ProjectionLine[]>;
  /**
   * Which upstream endpoint served this provider's latest `getWeekProjections` pull of the week
   * (#184: `v1` or the `app` fallback), for the job logs and the data status. Providers with one
   * source leave it out; undefined when the week was not pulled.
   */
  projectionSource?(season: number, week: number): ProjectionSource | undefined;
  getTrending(type: TrendingType, asOf: Date, options?: TrendingOptions): Promise<TrendingEntry[]>;
  /** Regular and postseason games with UTC kickoff times. */
  getSchedule(season: number, asOf: Date): Promise<ScheduledGame[]>;
  getByeWeeks(season: number, asOf: Date): Promise<ByeWeeks>;
  /**
   * The week's stats with stat corrections applied, for the Thursday official final. Providers
   * without a separate official source leave it out, and callers use `getWeekStats` (a historical
   * archive already serves the corrected version once it is known). `crosswalk` maps nflverse GSIS
   * ids to Sleeper ids.
   */
  getOfficialWeekStats?(
    season: number,
    week: number,
    asOf: Date,
    crosswalk?: IdCrosswalk
  ): Promise<StatLine[]>;
  /**
   * The week's games as they stand: scores, status, and for live games possession, down and
   * distance, and the red zone. Only a live source has it: historical providers leave it out, and
   * callers skip the feature. `games` is the week's schedule when the caller already has it (each
   * game is matched to ours by teams); without it the provider reads its own schedule.
   */
  getLiveGames?(
    season: number,
    week: number,
    asOf: Date,
    games?: readonly ScheduledGame[]
  ): Promise<LiveGame[]>;
  /**
   * One game's scoring plays with their descriptions (#164), by the game's ESPN id (`LiveGame`
   * `espnId`), in game order. Only a live source has it, like `getLiveGames`.
   */
  getScoringPlays?(espnId: string, asOf: Date): Promise<ScoringPlay[]>;
}
