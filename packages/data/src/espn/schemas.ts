import { z } from 'zod';

/**
 * ESPN's public NFL scoreboard (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`):
 * every game of a week with its score, status, and (while live) its situation. Only the fields we
 * read are validated and unknown fields are ignored. ESPN documents none of this, so everything
 * past the teams and the state is optional: a game without a `situation` (pregame, final, between
 * plays) simply has no possession and no red zone.
 */

const optionalString = z.string().nullable().optional();
const optionalNumber = z.number().nullable().optional();

export const espnCompetitorSchema = z.object({
  homeAway: z.enum(['home', 'away']),
  team: z.object({ id: z.string(), abbreviation: z.string() }),
  /** A string (`"14"`); some feeds have sent numbers. */
  score: z.union([z.string(), z.number()]).nullable().optional()
});

export const espnSituationSchema = z.object({
  /** The ESPN team id with the ball. */
  possession: optionalString,
  isRedZone: z.boolean().nullable().optional(),
  down: optionalNumber,
  distance: optionalNumber,
  yardLine: optionalNumber,
  downDistanceText: optionalString,
  shortDownDistanceText: optionalString,
  possessionText: optionalString
});
export type EspnSituation = z.infer<typeof espnSituationSchema>;

export const espnStatusSchema = z.object({
  period: optionalNumber,
  displayClock: optionalString,
  type: z.object({ state: z.enum(['pre', 'in', 'post']), shortDetail: optionalString })
});

export const espnCompetitionSchema = z.object({
  date: optionalString,
  status: espnStatusSchema,
  competitors: z.array(espnCompetitorSchema).min(2),
  situation: espnSituationSchema.nullable().optional()
});

export const espnEventSchema = z.object({
  id: z.string(),
  date: optionalString,
  competitions: z.array(espnCompetitionSchema).min(1)
});
export type EspnEvent = z.infer<typeof espnEventSchema>;

/**
 * The scoreboard's envelope. Events are validated one at a time (`normalizeScoreboard`), so one odd
 * game does not hide the others.
 */
export const espnScoreboardSchema = z.object({ events: z.array(z.unknown()) });
export type EspnScoreboard = z.infer<typeof espnScoreboardSchema>;
