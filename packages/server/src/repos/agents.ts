import { AgentSeatConfigSchema, type AgentLeagueMemory } from '@fantasy/core';
import { z } from 'zod';
import { ApiError } from '../errors.js';

/**
 * Agent platform persistence (issues #39, #41, #45, #93): seat configs with version history, the
 * per-agent league memory (notes, rivalries, trades, decisions, a chat snapshot), task records (the idempotency claim and the observability record in one),
 * weekly usage rollups, and per-agent trigger state for cooldowns. Everything lives in the league
 * table; the key layout is in the DynamoDB implementation (`dynamo/agents.ts`).
 */

export const AgentSeatRecordSchema = z.object({
  leagueId: z.string(),
  teamId: z.string(),
  /** Globally unique agent id; the agent's principal and idempotency scope. */
  agentId: z.string(),
  config: AgentSeatConfigSchema,
  /** 1 for the first config; incremented on every change. */
  version: z.number().int().min(1),
  updatedAt: z.string(),
  /** Principal key of whoever made the change (`user#<sub>`). */
  updatedBy: z.string()
});
export type AgentSeatRecord = z.infer<typeof AgentSeatRecordSchema>;

export const AgentToolCallSchema = z.object({
  name: z.string(),
  mutation: z.boolean(),
  ok: z.boolean(),
  errorCode: z.string().nullable()
});
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

export const AgentModelUsageSchema = z.object({
  modelKey: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
  /** True when token counts were estimated from text length rather than reported by the model. */
  estimatedTokens: z.boolean()
});
export type AgentModelUsage = z.infer<typeof AgentModelUsageSchema>;

export const AGENT_TASK_STATUSES = ['completed', 'fallback', 'failed', 'skipped'] as const;

/**
 * Sealed information in a task's summary (issue #122): waiver bids and pending trade terms that no
 * one but the agent's own team may see yet. The activity log shows `summary` instead of the real
 * reasoning until every sealed move has resolved (`sealedSummary` in operations/agents/activity.ts).
 */
export const AgentTaskSealSchema = z.object({
  /** The summary to show while sealed: what kind of move, without bids, players, or terms. */
  summary: z.string(),
  /**
   * Trades the summary describes. `public`: sealed until other teams can see the trade (accepted,
   * in review, processed, or vetoed); a rejected or expired offer stays private. `final`: sealed
   * until the trade is processed or vetoed (a veto vote, while the review is still open).
   */
  trades: z.array(z.object({ tradeId: z.string(), until: z.enum(['public', 'final']) })).default([]),
  /** Waiver claims (ids) the summary describes: sealed while any of them is pending. */
  waiverClaims: z.array(z.string()).default([]),
  /**
   * True when the task's prompt held private memory that never becomes public (a rejected offer, a
   * note from before memory visibility, #206): the summary stays sealed for good.
   */
  withheld: z.boolean().optional()
});
export type AgentTaskSeal = z.infer<typeof AgentTaskSealSchema>;

export const AgentTaskRecordSchema = z.object({
  taskId: z.string(),
  leagueId: z.string(),
  teamId: z.string(),
  agentId: z.string(),
  kind: z.string(),
  week: z.number().int(),
  trigger: z.object({ detailType: z.string(), eventId: z.string() }),
  /** `completed`: the model decided. `fallback`: deterministic code decided. `skipped`: nothing ran. */
  status: z.enum(AGENT_TASK_STATUSES),
  /** Why the deterministic fallback ran (kill_switch, budget_exceeded, model_error, timeout, ...). */
  fallbackReason: z.string().nullable(),
  toolsCalled: z.array(AgentToolCallSchema),
  finalAction: z.string(),
  reasoningSummary: z.string(),
  latencyMs: z.number().min(0),
  usage: z.array(AgentModelUsageSchema),
  costUsd: z.number().min(0),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** Set when `reasoningSummary` holds sealed information; never shown to the commissioner. */
  sealed: AgentTaskSealSchema.optional()
});
export type AgentTaskRecord = z.infer<typeof AgentTaskRecordSchema>;

export const AgentUsageRowSchema = z.object({
  leagueId: z.string(),
  week: z.number().int(),
  agentId: z.string(),
  modelKey: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  tasks: z.number()
});
/** One weekly rollup row per league, week, agent, and model. */
export type AgentUsageRow = z.infer<typeof AgentUsageRowSchema>;

export interface AgentTriggerState {
  leagueId: string;
  agentId: string;
  /** When the agent last accepted a non-urgent trigger (ISO). */
  lastTriggeredAt: string;
}

export type AgentTaskClaim =
  { status: 'started' } | { status: 'done'; record: AgentTaskRecord } | { status: 'in_progress' };

export interface AgentRepository {
  getSeat(leagueId: string, teamId: string): Promise<AgentSeatRecord | null>;
  listSeats(leagueId: string): Promise<AgentSeatRecord[]>;
  /**
   * Writes `record` (whose `version` is the new version) if the stored version is `record.version − 1`
   * (or no seat exists and `record.version` is 1), then appends it to the seat's history.
   * Fails with CONFLICT otherwise.
   */
  putSeat(record: AgentSeatRecord): Promise<void>;
  /** Newest first. */
  seatHistory(leagueId: string, teamId: string, limit?: number): Promise<AgentSeatRecord[]>;

  /** The agent's private league memory (empty when it has none). */
  getMemory(leagueId: string, agentId: string): Promise<AgentLeagueMemory>;
  /**
   * Read-modify-write of the agent's memory, retried on a concurrent write. `update` must be pure
   * (core `rememberEvent`). Returns the memory after the update.
   */
  updateMemory(
    leagueId: string,
    agentId: string,
    update: (memory: AgentLeagueMemory) => AgentLeagueMemory
  ): Promise<AgentLeagueMemory>;

  /** Claims a task id: once per trigger, with takeover after `lockUntil` if a run crashed. */
  claimTask(input: { taskId: string; now: Date; lockUntil: Date }): Promise<AgentTaskClaim>;
  /** Stores the finished task record (and makes it listable). */
  completeTask(record: AgentTaskRecord, expiresAt: Date): Promise<void>;
  /** Newest first. */
  listTasks(leagueId: string, query?: { teamId?: string; limit?: number }): Promise<AgentTaskRecord[]>;

  /** Adds to the weekly rollup row for (league, week, agent, model). */
  addUsage(row: AgentUsageRow): Promise<void>;
  weekUsage(leagueId: string, week: number): Promise<AgentUsageRow[]>;

  getTriggerState(leagueId: string, agentId: string): Promise<AgentTriggerState | null>;
  putTriggerState(state: AgentTriggerState): Promise<void>;
  /**
   * Takes one use of a rolling-window limit (#196: an agent's chat-driven actions a day, the DM
   * threads it starts with a team a day, its posts in a matchup room a week), atomically: the uses
   * inside `windowMs` before `now` are counted and a new one is recorded only if they are below
   * `cap`, by a conditional write on the limit's revision, re-read and retried when another claim
   * got there first. `full` when the cap is reached; `contended` when the retries ran out (callers
   * treat it as full).
   */
  claimLimit(input: LimitClaim): Promise<LimitClaimResult>;
}

export interface LimitClaim {
  leagueId: string;
  /** The limit and whose it is, e.g. `<agentId>#chat-action`. */
  key: string;
  now: Date;
  windowMs: number;
  cap: number;
}

export type LimitClaimResult = 'claimed' | 'full' | 'contended';

/** Claim attempts before a contended limit counts as full. */
export const LIMIT_CLAIM_ATTEMPTS = 8;

export function staleSeat(teamId: string): ApiError {
  return new ApiError(
    'CONFLICT',
    `The agent seat for team ${teamId} changed while this request was running.`,
    {
      fix: 'Read the seat again with get_agent_seat and retry with its current version.'
    }
  );
}

/** Globally unique agent id for a league seat (also the idempotency scope `agent#<id>`). */
export function agentIdFor(leagueId: string, teamId: string): string {
  return `${leagueId}.${teamId}`;
}
