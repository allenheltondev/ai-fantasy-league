import { ACHIEVEMENT_IDS, CHECK_IN_SLOTS, NOTABLE_PICK_KINDS, TRADE_STATUSES } from '@fantasy/core';
import { z } from 'zod';
import { CHAT_MESSAGE_KINDS, ChatMessageSchema } from '../chat/model.js';
import { NotificationSchema } from '../notifications/model.js';
import { PlayerRefSchema, STATUS_SOURCES } from '../players/model.js';
import { NflGameSchema, RedZoneTeamSchema } from '../season/nfl-games.js';
import { ScoringLogEntrySchema } from '../season/scoring-log.js';
import type { EventDetail, FantasyEventType } from './publisher.js';

/**
 * The event contract (issue #112): the detail of every event type that has a consumer, as a zod
 * schema. `EventPublisher.publish` is typed from this map, so an emitter that drops or renames a
 * field fails typecheck, and consumers (the chat system messages, the realtime relay, the agent
 * router) read the same types. The cross-stream contract suite (`packages/agents/test/contract`)
 * runs the real emitters and checks their details parse here and render in every consumer.
 *
 * Event types without a schema yet (`Agent Action Requested`) take any object; add a schema
 * when the emitter lands.
 */

const id = z.string().min(1);
const week = z.number().int().min(1).max(18);
const iso = z.string();

const recoveryIdentity = { eventKey: z.string().optional(), occurredAt: z.string().optional() };

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

/** One waiver claim that failed in a run, and why (the claim's `failure`). */
export const WaiverLossSchema = z.object({
  teamId: id,
  playerId: id,
  player: PlayerRefSchema.nullable().describe('Null only when the player is missing from the player store.'),
  code: z.string().describe('The failure code, e.g. PLAYER_NOT_AVAILABLE or INSUFFICIENT_FAAB.'),
  reason: z.string().describe('Why the claim failed, for the team that made it.')
});
export type WaiverLoss = z.infer<typeof WaiverLossSchema>;

/** The biggest winning margin of a week. */
export const BlowoutSchema = z.object({
  winnerTeamId: id,
  loserTeamId: id,
  margin: z.number()
});

/**
 * Every `Trade *` state-machine event (`tradeEventDetail` in trades/lifecycle.ts). `fromTeamId`
 * made the offer and `toTeamId` answers it; the player lists are what each side sends and drops.
 */
export const TradeEventDetailSchema = z.object({
  leagueId: id,
  tradeId: id,
  status: z.enum(TRADE_STATUSES),
  fromTeamId: id,
  toTeamId: id,
  teamIds: z.tuple([id, id]),
  fromPlayers: z.array(PlayerRefSchema),
  toPlayers: z.array(PlayerRefSchema),
  fromDrops: z.array(PlayerRefSchema),
  toDrops: z.array(PlayerRefSchema),
  counterOf: z.string().nullable(),
  expiresAt: iso,
  reviewEndsAt: iso.nullable(),
  review: z.enum(['league_vote', 'commissioner', 'none']),
  voided: z
    .boolean()
    .optional()
    .describe(
      'Trade Vetoed: cancelled because it no longer validated. Trade Expired: an open offer voided because a player in it changed rosters.'
    ),
  reason: z.string().optional(),
  reasonCode: z.string().optional()
});
export type TradeEventDetail = z.infer<typeof TradeEventDetailSchema>;

const RecapEntrySchema = z.object({
  overall: z.number().int().min(1),
  round: z.number().int().min(1),
  teamId: id,
  playerId: id,
  adp: z.number().nullable().describe("The player's consensus rank when picked."),
  value: z.number().nullable().describe('Picks after ADP: positive for a steal, negative for a reach.'),
  reason: z.string().nullable().describe('Why the team made the pick, in its own words.')
});

/** The draft recap (core `draftRecap`): the biggest steals and reaches, and each agent's first pick. */
export const DraftRecapSchema = z.object({
  picks: z.number().int(),
  steals: z.array(RecapEntrySchema),
  reaches: z.array(RecapEntrySchema),
  agentPicks: z.array(RecapEntrySchema).describe("Each agent team's first pick with its reasoning.")
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
    ...recoveryIdentity,
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
    auto: z.boolean(),
    adp: z.number().nullable().optional().describe("The player's consensus rank when picked."),
    notable: z
      .enum(NOTABLE_PICK_KINDS)
      .nullable()
      .optional()
      .describe('A steal or reach by ADP, or an agent seat’s first-round pick (core `notablePick`).'),
    reason: z.string().nullable().optional().describe('Why the team made the pick (an agent’s reasoning).')
  }),
  'Draft Completed': z.object({
    leagueId: id,
    picks: z.number().int(),
    rounds: z.number().int(),
    week,
    completedAt: iso,
    recap: DraftRecapSchema.optional(),
    recapText: z.string().optional().describe('The recap as one chat line (core `formatDraftRecap`).')
  }),
  'Draft Paused': z.object({
    leagueId: id,
    pick: z.number().int().min(1).nullable(),
    secondsLeft: z.number().int().nullable().describe('Seconds the team on the clock keeps for the resume.'),
    pausedAt: iso
  }),
  'Draft Resumed': z.object({
    leagueId: id,
    pick: z.number().int().min(1).nullable(),
    deadline: iso,
    secondsLeft: z.number().int(),
    resumedAt: iso
  }),
  'Draft Pick Deadline': z.object({ leagueId: id, pick: z.number().int().min(1), deadline: iso }),
  'Draft Start Scheduled': z.object({ leagueId: id, scheduledAt: iso }),
  'Draft Reminder Due': z.object({ leagueId: id, scheduledAt: iso }),
  'Draft Starting Soon': z.object({
    leagueId: id,
    scheduledAt: iso,
    minutes: z.number().int().min(1).describe('Minutes until the draft starts.')
  }),
  'Draft Start Blocked': z.object({
    leagueId: id,
    scheduledAt: iso,
    commissionerId: id,
    code: z.string().describe('Why it could not start (the start_draft error code).'),
    reason: z.string(),
    fix: z.string().describe('What the commissioner can do about it.')
  }),
  'Week Rolled Over': z.union([
    z.object({
      ...recoveryIdentity,
      leagueId: id,
      season: z.number().int(),
      fromWeek: week,
      week,
      phase: z.string(),
      rolledOverAt: iso
    }),
    z.object({
      ...recoveryIdentity,
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
    lost: z
      .array(WaiverLossSchema)
      .optional()
      .describe(
        'Claims that failed in this run, with why (#165). Private to each team: the relay keeps them off the league topic.'
      ),
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
    changedAt: iso,
    source: z
      .enum(STATUS_SOURCES)
      .describe(
        "Where the change was read (#200): Sleeper's twice-daily sync, or ESPN's game-day injury report (inactives about 90 minutes before kickoff)."
      )
  }),
  'Chat Mention': z.object({
    leagueId: id,
    roomId: id.describe('The room of the message; in a DM, the other team is always addressed.'),
    messageId: id,
    authorTeamId: z.string().nullable(),
    authorType: z.enum(CHAT_MESSAGE_KINDS),
    mentionedTeamIds: z.array(id),
    replyToAgentDepth: z
      .number()
      .int()
      .min(0)
      .describe(
        'Agent-to-agent thread depth of the message (#153): 0 unless an AI manager answered another AI manager. An agent-authored mention at depth 1 or more never triggers an agent.'
      )
  }),
  'Chat Moment': z.object({
    leagueId: id,
    moment: z.string(),
    messageId: id,
    sourceEventType: z.string(),
    sourceEventId: z.string(),
    teamId: id.optional(),
    roomId: id.describe('The room the moment was announced in; agents react there.'),
    teamIds: z.array(id).optional().describe('A matchup room moment: the two teams playing, who react first.')
  }),
  'Chat Message Posted': z.object({
    leagueId: id,
    roomId: id,
    teamIds: z
      .tuple([id, id])
      .nullable()
      .describe(
        'A DM: the only two teams that may see it (the relay sends it to their team topics alone). Null for rooms the whole league reads.'
      ),
    message: ChatMessageSchema
  }),
  'Notification Created': z.object({
    leagueId: id,
    teamId: id.describe('The team whose inbox it is in: the relay sends it to that team topic alone.'),
    notification: NotificationSchema
  }),
  'Scores Updated': z.union([
    z.object({
      leagueId: id,
      season: z.number().int(),
      week,
      matchups: z.array(ScoreLineSchema),
      scoringLog: z
        .array(z.object({ matchupId: id, entries: z.array(ScoringLogEntrySchema) }))
        .optional()
        .describe(
          'Recent scoring log entries (#162) of the matchups whose score changed, newest first, bench included; the same entries get_scoring_log serves, so a client merges them by id.'
        ),
      updatedAt: iso
    }),
    z.object({ season: z.number().int(), week: z.number().int(), playerIds: z.array(id), updatedAt: iso })
  ]),
  'NFL Games Updated': z.object({
    season: z.number().int(),
    week: z.number().int(),
    games: z.array(NflGameSchema).describe('Every game of the week, as `get_nfl_games` serves them.'),
    redZone: z.array(RedZoneTeamSchema).describe('The teams with the ball inside the opponent’s 20.'),
    updatedAt: iso
  }),
  'Week Provisionally Final': z.object({
    ...recoveryIdentity,
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
    ...recoveryIdentity,
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
  'Model Power Rankings': z.object({
    ...recoveryIdentity,
    leagueId: id,
    season: z.number().int(),
    week: week.describe('The week that just ended.'),
    leaderModelName: z.string().describe('The top model (or "Human" when people lead).'),
    rankings: z
      .array(
        z.object({
          rank: z.number().int().min(1),
          modelKey: z.string().describe('A catalog model key, or "human".'),
          modelName: z.string(),
          teams: z.number().int().min(1),
          wins: z.number().int(),
          losses: z.number().int(),
          ties: z.number().int(),
          winRate: z.number().nullable(),
          tradeValue: z.number().describe('Player value won (+) or lost (-) in processed trades.'),
          waiverHitRate: z.number().nullable(),
          costUsd: z.number()
        })
      )
      .min(1),
    lines: z.array(z.string()).min(1).describe('One chat line per model, best first.'),
    postedAt: iso
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
  'Team Renamed': z.object({
    leagueId: id,
    teamId: id,
    from: z.string().describe('The old name.'),
    to: z.string().describe('The new name.'),
    by: z
      .enum(['owner', 'commissioner', 'agent'])
      .describe('Who renamed it. The chat announces renames by people; an AI manager announces its own.')
  }),
  'Agent Budget Exceeded': z.object({
    leagueId: id,
    week: z.number().int().min(0).describe('The budget week (the league week, 0 before the season).'),
    spentUsd: z.number().min(0).describe('Estimated model spend this week.'),
    ceilingUsd: z.number().min(0).describe('The league’s weekly ceiling.')
  }),
  'Manager Check-In': z.object({
    leagueId: id,
    slot: z.enum(CHECK_IN_SLOTS),
    date: z.string().describe('The local (US Eastern) date of the check-in; with `slot`, its once-only key.'),
    at: iso.describe('When the check-in was scheduled.'),
    nextAt: iso.describe('When the next check-in is: agents act before it.'),
    week: week.nullable()
  }),
  'Settings Changed': z.object({
    leagueId: id,
    changedPaths: z.array(z.string()),
    changedBy: z.string(),
    version: z.number().int(),
    phase: z.string()
  }),
  'Trade Proposed': TradeEventDetailSchema,
  'Trade Countered': TradeEventDetailSchema,
  'Trade Accepted': TradeEventDetailSchema,
  'Trade Rejected': TradeEventDetailSchema,
  'Trade Expired': TradeEventDetailSchema,
  'Trade Withdrawn': TradeEventDetailSchema,
  'Trade Processed': TradeEventDetailSchema,
  'Trade Vetoed': TradeEventDetailSchema,
  'Trade Offer Deadline': z.object({ leagueId: id, tradeId: id, expiresAt: iso }),
  'Trade Review Ended': z.object({ leagueId: id, tradeId: id, reviewEndsAt: iso.nullable() }),
  'Trade Deadline Passed': z.object({ leagueId: id, deadlineWeek: week, deadlineAt: iso })
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
