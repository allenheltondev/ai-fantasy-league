import { z } from 'zod';

/**
 * Raw Sleeper response shapes. Only the fields we read are validated; unknown fields are ignored.
 * Sleeper leaves many fields null for obscure players, so most are nullable.
 */

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const sleeperPlayerSchema = z.object({
  player_id: z.string(),
  first_name: nullableString,
  last_name: nullableString,
  full_name: nullableString,
  search_full_name: nullableString,
  position: nullableString,
  fantasy_positions: z.array(z.string()).nullable().optional(),
  team: nullableString,
  status: nullableString,
  injury_status: nullableString,
  depth_chart_order: nullableNumber,
  depth_chart_position: nullableString,
  active: z.boolean().nullable().optional(),
  gsis_id: nullableString,
  /** ESPN's athlete id: a number in the live payload, a string in some older ones. */
  espn_id: z.union([z.number(), z.string()]).nullable().optional(),
  age: nullableNumber,
  years_exp: nullableNumber,
  /** Sleeper's consensus rank; 9999999 means unranked. */
  search_rank: nullableNumber,
  // Sleeper sends jersey numbers as numbers, but has sent strings before.
  number: z.union([z.number(), z.string()]).nullable().optional()
});
export type SleeperPlayer = z.infer<typeof sleeperPlayerSchema>;

/** `/v1/players/nfl`: a map keyed by player id. */
export const sleeperPlayersSchema = z.record(z.string(), sleeperPlayerSchema);
export type SleeperPlayers = z.infer<typeof sleeperPlayersSchema>;

/** `/v1/state/nfl` */
export const sleeperStateSchema = z.object({
  week: z.number().int(),
  season: z.string(),
  season_type: z.string(),
  display_week: z.number().int().nullable().optional(),
  leg: z.number().int().nullable().optional(),
  league_season: z.string().nullable().optional(),
  previous_season: z.string().nullable().optional(),
  season_start_date: z.string().nullable().optional()
});
export type SleeperState = z.infer<typeof sleeperStateSchema>;

/**
 * `/v1/stats/nfl/regular/{season}/{week}` and `/v1/projections/...`: a map keyed by player id of
 * stat key → number. Sleeper occasionally sends null for a stat; we drop those.
 */
export const sleeperWeekStatsSchema = z.record(z.string(), z.record(z.string(), z.number().nullable()));
export type SleeperWeekStats = z.infer<typeof sleeperWeekStatsSchema>;

/** `/v1/players/nfl/trending/{add|drop}` */
export const sleeperTrendingSchema = z.array(z.object({ player_id: z.string(), count: z.number() }));
export type SleeperTrending = z.infer<typeof sleeperTrendingSchema>;
