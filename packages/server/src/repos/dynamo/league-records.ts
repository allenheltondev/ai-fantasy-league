import {
  NAME_SET_BY,
  REPORT_CARD_GRADES,
  LeagueSettingsSchema,
  PositionSchema,
  RosterSlotSchema
} from '@fantasy/core';
import { z } from 'zod';
import { DRAFT_STATUSES, LEAGUE_PHASES, SEAT_TYPES } from '../types.js';
import { weekKey } from './query.js';

/** Item shapes in the league partition (`pk = LEAGUE#<leagueId>`), parsed on every read. */

export const leaguePk = (leagueId: string) => `LEAGUE#${leagueId}`;

export const leagueKey = (leagueId: string) => ({ pk: leaguePk(leagueId), sk: 'META' });
export const teamKey = (leagueId: string, teamId: string) => ({
  pk: leaguePk(leagueId),
  sk: `TEAM#${teamId}`
});
export const memberKey = (leagueId: string, userId: string) => ({
  pk: leaguePk(leagueId),
  sk: `MEMBER#${userId}`
});
export const inviteKey = (leagueId: string, inviteId: string) => ({
  pk: leaguePk(leagueId),
  sk: `INVITE#${inviteId}`
});
export const matchupKey = (leagueId: string, week: number, matchupId: string) => ({
  pk: leaguePk(leagueId),
  sk: `MATCHUP#${weekKey(week)}#${matchupId}`
});
export const standingsKey = (leagueId: string, week: number) => ({
  pk: leaguePk(leagueId),
  sk: `STANDINGS#${weekKey(week)}`
});

export const lineupKey = (leagueId: string, week: number, teamId: string) => ({
  pk: leaguePk(leagueId),
  sk: `LINEUP#${weekKey(week)}#${teamId}`
});

export const draftKey = (leagueId: string) => ({ pk: leaguePk(leagueId), sk: 'DRAFT' });
export const draftLobbyKey = (leagueId: string, memberKey: string) => ({
  pk: leaguePk(leagueId),
  sk: `DRAFTLOBBY#${memberKey}`
});
export const draftReportKey = (leagueId: string) => ({ pk: leaguePk(leagueId), sk: 'DRAFTREPORT' });
export const draftQueueKey = (leagueId: string, teamId: string) => ({
  pk: leaguePk(leagueId),
  sk: `DRAFTQUEUE#${teamId}`
});

/** Items that share an `sk` prefix with others (`TEAM#<id>#AGENT`) are told apart by `entity`. */
export const ENTITY = {
  league: 'league',
  team: 'team',
  member: 'member',
  invite: 'invite',
  inviteCode: 'invite-code',
  codeAttempts: 'invite-code-attempts',
  matchup: 'matchup',
  standings: 'standings',
  lineup: 'lineup',
  draft: 'draft',
  draftQueue: 'draftQueue',
  draftLobby: 'draftLobby',
  draftReport: 'draftReport'
} as const;

const iso = z.string();

export const LeagueRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  season: z.number(),
  phase: z.enum(LEAGUE_PHASES),
  week: z.number().nullable(),
  settings: LeagueSettingsSchema,
  commissionerId: z.string(),
  commissionerName: z.string(),
  createdBy: z.string(),
  scheduleSeed: z.string(),
  draftStartup: z
    .object({
      by: z.string(),
      at: z.string().optional(),
      leaseUntil: z.string().optional(),
      owner: z.string().optional()
    })
    .nullable()
    .optional(),
  pendingRollover: z
    .object({ fromWeek: z.number().int(), at: iso, priorityOrder: z.array(z.string()).optional() })
    .nullable()
    .optional(),
  deadlines: z.object({
    draftStartsAt: iso.nullable(),
    nextLineupLockAt: iso.nullable(),
    nextWaiverRunAt: iso.nullable(),
    tradeDeadlineAt: iso.nullable(),
    lineupLocksAt: z.array(iso).optional(),
    postDraftWaiversUntil: iso.nullable().optional()
  }),
  createdAt: iso,
  updatedAt: iso,
  version: z.number()
});

export const TeamRecordSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  name: z.string(),
  seatType: z.enum(SEAT_TYPES),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  avatarSeed: z.string().optional(),
  nameSetBy: z.enum(NAME_SET_BY).optional(),
  renames: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        by: z.enum(['owner', 'commissioner', 'agent']),
        at: iso,
        week: z.number()
      })
    )
    .optional(),
  agentConfigId: z.string().nullable(),
  draftSlot: z.number(),
  faabRemaining: z.number(),
  waiverPriority: z.number(),
  waiverPriorityResetKey: z.string().optional(),
  roster: z.array(z.string()),
  occupiedSince: iso.optional(),
  createdAt: iso,
  updatedAt: iso,
  version: z.number()
});

export const MemberRecordSchema = z.object({
  leagueId: z.string(),
  userId: z.string(),
  teamId: z.string(),
  joinedAt: iso
});

export const InviteRecordSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  tokenHash: z.string(),
  code: z.string().nullable().default(null),
  email: z.string().nullable(),
  maxUses: z.number(),
  uses: z.number(),
  expiresAt: iso,
  revokedAt: iso.nullable(),
  createdBy: z.string(),
  createdAt: iso,
  version: z.number()
});

export const MatchupRecordSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  week: z.number(),
  kind: z.enum(['regular', 'playoff']),
  homeTeamId: z.string(),
  awayTeamId: z.string(),
  homeScore: z.number().nullable(),
  awayScore: z.number().nullable(),
  status: z.enum(['scheduled', 'in_progress', 'final'])
});

const GameResultSchema = z.enum(['W', 'L', 'T']);

export const StandingsRecordSchema = z.object({
  leagueId: z.string(),
  week: z.number(),
  computedAt: iso,
  rows: z.array(
    z.object({
      teamId: z.string(),
      rank: z.number(),
      wins: z.number(),
      losses: z.number(),
      ties: z.number(),
      gamesPlayed: z.number(),
      winPct: z.number(),
      pointsFor: z.number(),
      pointsAgainst: z.number(),
      streak: z.object({ result: GameResultSchema, length: z.number() }).nullable(),
      tiebreakerOverNext: z.enum(['points_for', 'head_to_head', 'coin_flip']).nullable()
    })
  )
});

export const LineupRecordSchema = z.object({
  leagueId: z.string(),
  teamId: z.string(),
  week: z.number(),
  entries: z.array(z.object({ playerId: z.string(), slot: RosterSlotSchema })),
  updatedAt: iso,
  updatedBy: z.string()
});

export const DraftRecordSchema = z.object({
  leagueId: z.string(),
  state: z.object({
    teamIds: z.array(z.string()),
    rounds: z.number(),
    pickSeconds: z.number(),
    positionLimits: z.partialRecord(PositionSchema, z.number()),
    tradedPicks: z.array(
      z.object({ round: z.number(), originalTeamId: z.string(), ownerTeamId: z.string() })
    ),
    picks: z.array(
      z.object({
        overall: z.number(),
        round: z.number(),
        pick: z.number(),
        teamId: z.string(),
        playerId: z.string(),
        positions: z.array(PositionSchema),
        madeAt: iso.nullable(),
        auto: z.boolean(),
        adp: z.number().nullable().optional(),
        reason: z.string().optional()
      })
    )
  }),
  status: z.enum(DRAFT_STATUSES),
  startedAt: iso,
  deadline: iso.nullable(),
  pausedRemainingSeconds: z.number().nullable(),
  completedAt: iso.nullable(),
  updatedAt: iso,
  version: z.number()
});

export const DraftReportCardSchema = z.object({
  leagueId: z.string(),
  status: z.enum(['grading', 'ready']),
  claimedUntil: iso.nullable(),
  source: z.enum(['model', 'computed']).nullable(),
  fallbackReason: z.string().nullable(),
  modelKey: z.string().nullable(),
  summary: z.string(),
  teams: z.array(
    z.object({
      teamId: z.string(),
      grade: z.enum(REPORT_CARD_GRADES),
      headline: z.string(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
      analysis: z.string(),
      projectedWins: z.number().int(),
      projectedLosses: z.number().int(),
      projectedRank: z.number().int(),
      projectedPoints: z.number(),
      expectedWins: z.number()
    })
  ),
  createdAt: iso,
  updatedAt: iso
});

export const DraftQueueRecordSchema = z.object({
  leagueId: z.string(),
  teamId: z.string(),
  playerIds: z.array(z.string()),
  updatedAt: iso,
  updatedBy: z.string()
});
