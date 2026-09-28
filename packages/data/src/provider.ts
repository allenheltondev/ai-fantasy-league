import type { IdCrosswalk } from './nflverse/crosswalk.js';
import type {
  ByeWeeks,
  NflState,
  Player,
  ProjectionLine,
  ScheduledGame,
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
  getOfficialWeekStats?(season: number, week: number, asOf: Date, crosswalk?: IdCrosswalk): Promise<StatLine[]>;
}
