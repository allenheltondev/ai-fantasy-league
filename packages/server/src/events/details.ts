import { ACHIEVEMENT_IDS } from '@fantasy/core';
import { z } from 'zod';
import { CHAT_MESSAGE_KINDS, ChatMessageSchema } from '../chat/model.js';
import { PlayerRefSchema } from '../players/model.js';
import type { EventDetail, FantasyEventType } from './publisher.js';

/**
 * The event contract (issue #112): the detail of every event type that has a consumer, as a zod
 * schema. `EventPublisher.publish` is typed from this map, so an emitter that drops or renames a
 * field fails typecheck, and consumers (the chat system messages, the realtime relay, the agent
 * router) read the same types. The cross-stream contract suite (`packages/agents/test/contract`)
 * runs the real emitters and checks their details parse here and render in every consumer.
 *
 * Event types without a schema yet (the trade events, `Agent Action Requested`) take any object;
 * add a schema when the emitter lands.
 */

const id = z.string().min(1);
const week = z.number().int().min(1).max(18);
const iso = z.string();

const ScoreLineSchema = z.object({
  matchupId: z.string(),
  homeTeamId: z.string(),
  awayTeamId: z.string(),
  homeScore: z.number().nullable(),
  awayScore: z.number().nullable(),
  status: z.string()
});

const NflWeekSchema = z.object({ season: z.number().int(), seasonType: z.string(), week: z.number().int() });

/** One awarded waiver claim. `bid` is what the team offered, `cost` the FAAB it paid. */
export const WaiverAwardSchema = z.object({
  teamId: id,
  playerId: id,
  player: PlayerRefSchema.nullable().describe('Null only when the player is missing from the player store.'),
  dropPlayerId: z.string().nullable(),
  dropPlayer: PlayerRefSchema.nullable(),
  bid: z.number().int().min(0),
  cost: z.number().int().min(0)
});
export type WaiverAward = z.infer<typeof WaiverAwardSchema>;

/** The biggest winning margin of a week. */
export const BlowoutSchema = z.object({
  winnerTeamId: id,
  loserTeamId: id,
  margin: z.number()
});

export const EVENT_DETAIL_SCHEMAS = {
  'League Created': z.object({
    leagueId: id,
    name: z.string(),
    season: z.number().int(),
    commissionerId: z.string(),
    teamCount: z.number().int(),
    startWeek: week,
    midSeasonStart: z.boolean()
  }),
  'Draft Turn Started': z.object({
    leagueId: id,
    teamId: id,
    pick: z.number().int().min(1),
    round: z.number().int().min(1),
    pickInRound: z.number().int().min(1),
    deadline: iso,
    pickSeconds: z.number().int()
  }),
  'Draft Pick Made': z.object({
    leagueId: id,
    teamId: id,
    playerId: id,
    player: PlayerRefSchema,
    overall: z.number().int().min(1),
    round: z.number().int().min(1),
    pick: z.number().int().min(1),
    auto: z.boolean()
  }),
  'Draft Completed': z.object({
    leagueId: id,
    picks: z.number().int(),
    rounds: z.number().int(),
    week,
    completedAt: iso
  }),
  'Draft Pick Deadline': z.object({ leagueId: id, pick: z.number().int().min(1), deadline: iso }),
  'Week Rolled Over': z.union([
    z.object({
      leagueId: id,
      season: z.number().int(),
      fromWeek: week,
      week,
      phase: z.string(),
      rolledOverAt: iso
    }),
    z.object({
      season: z.number().int(),
      seasonType: z.string(),
      week: z.number().int(),
      kind: z.enum(['week', 'season_type', 'season']),
      from: NflWeekSchema,
      to: NflWeekSchema,
      rolledOverAt: iso
    })
  ]),
  'Lineup Lock Approaching': z.object({
    leagueId: id,
    season: z.number().int(),
    week,
    lockAt: iso,
    nflTeams: z.array(z.string())
  }),
  'Waiver Window Opened': z.object({ leagueId: id, week, opensAt: iso, closesAt: iso }),
  'Waivers Processed': z.object({
    leagueId: id,
    runId: z.string(),
    week,
    awarded: z.array(WaiverAwardSchema),
    failed: z.number().int().min(0),
    pending: z.number().int().min(0)
  }),
  'Player News Alert': z.object({
    newsId: id,
    title: z.string(),
    url: z.string(),
    source: z.string(),
    publishedAt: iso,
    playerIds: z.array(id).min(1),
    teams: z.array(z.string())
  }),
  'Player Status Changed': z.object({
    playerId: id,
    name: z.string(),
    team: z.string().nullable(),
    position: z.string(),
    changes: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
    changedAt: iso
  }),
  'Chat Mention': z.object({
    leagueId: id,
    messageId: id,
    authorTeamId: z.string().nullable(),
    authorType: z.enum(CHAT_MESSAGE_KINDS),
    mentionedTeamIds: z.array(id)
  }),
  'Chat Moment': z.object({
    leagueId: id,
    moment: z.string(),
    messageId: id,
    sourceEventType: z.string(),
    sourceEventId: z.string(),
    teamId: id.optional()
  }),
  'Chat Message Posted': z.object({ leagueId: id, message: ChatMessageSchema }),
  'Scores Updated': z.union([
    z.object({
      leagueId: id,
      season: z.number().int(),
      week,
      matchups: z.array(ScoreLineSchema),
      updatedAt: iso
    }),
    z.object({ season: z.number().int(), week: z.number().int(), playerIds: z.array(id), updatedAt: iso })
  ]),
  'Week Provisionally Final': z.object({
    leagueId: id,
    season: z.number().int(),
    week,
    matchups: z.array(ScoreLineSchema),
    topTeamId: z.string().nullable().describe('The week’s top-scoring team, or null with no scores.'),
    topScore: z.number().nullable(),
    blowout: BlowoutSchema.nullable(),
    finalizedAt: iso
  }),
  'Week Official Final': z.object({
    leagueId: id,
    season: z.number().int(),
    week,
    corrections: z.number().int().min(0).describe('Matchups whose score a stat correction changed.'),
    flipped: z.number().int().min(0).describe('Matchups whose winner changed.'),
    recap: z.string(),
    matchups: z.array(ScoreLineSchema),
    officialAt: iso
  }),
  'Stat Correction Applied': z.object({
    leagueId: id,
    season: z.number().int(),
    week,
    matchupId: id,
    teamId: id.describe('The side whose score moved the most.'),
    oldScore: z.number().nullable(),
    newScore: z.number(),
    before: z.object({ homeScore: z.number().nullable(), awayScore: z.number().nullable() }),
    after: ScoreLineSchema,
    resultFlipped: z.boolean(),
    winnerTeamId: id.describe('After the correction (home on a tie).'),
    loserTeamId: id,
    winnerScore: z.number(),
    loserScore: z.number()
  }),
  'Season Completed': z.object({
    leagueId: id,
    season: z.number().int(),
    championTeamId: z.string().nullable(),
    runnerUpTeamId: z.string().nullable(),
    consolationChampionTeamId: z.string().nullable(),
    completedAt: iso
  }),
  'Achievement Earned': z.object({
    leagueId: id,
    season: z.number().int(),
    teamId: id,
    achievementId: z.enum(ACHIEVEMENT_IDS),
    name: z.string(),
    reason: z.string(),
    week: week.nullable().describe('Null for a season award.'),
    awardedAt: iso
  }),
  'Track Activity': z.object({
    id: id.describe('Idempotency key for the rsc-core badge engine.'),
    userId: id.describe('The Cognito sub of the team owner.'),
    action: z.string(),
    service: z.literal('fantasy'),
    value: id
  }),
  'Member Joined': z.object({
    leagueId: id,
    userId: id,
    teamId: id,
    inviteId: id,
    name: z.string().describe('The person’s display name.')
  }),
  'Member Left': z.object({ leagueId: id, userId: id, teamId: id, reason: z.enum(['left', 'removed']) }),
  'Agent Seat Changed': z.object({
    leagueId: id,
    teamId: id,
    changedBy: z.string().describe('Principal key of whoever made the change (`user#<sub>`).'),
    phase: z.string(),
    version: z.number().int().min(1),
    changes: z
      .array(
        z.object({
          field: z.enum(['difficulty', 'archetype', 'model', 'personality']),
          from: z.string().describe('Display name before the change.'),
          to: z.string().describe('Display name after the change.')
        })
      )
      .min(1)
  }),
  'Settings Changed': z.object({
    leagueId: id,
    changedPaths: z.array(z.string()),
    changedBy: z.string(),
    version: z.number().int(),
    phase: z.string()
  })
} as const satisfies Partial<Record<FantasyEventType, z.ZodType>>;

export type EventDetailSchemas = typeof EVENT_DETAIL_SCHEMAS;
/** Event types with a typed detail. */
export type TypedEventType = keyof EventDetailSchemas;

/** The detail an emitter must send for `T` (any object for event types without a schema yet). */
export type EventDetailOf<T extends FantasyEventType> = T extends TypedEventType
  ? z.input<EventDetailSchemas[T]>
  : EventDetail;

/** The schema for a detail type, if it has one. */
export function eventDetailSchema(detailType: string): z.ZodType | undefined {
  return (EVENT_DETAIL_SCHEMAS as Partial<Record<string, z.ZodType>>)[detailType];
}
