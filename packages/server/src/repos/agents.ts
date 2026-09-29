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
  sealed: AgentTaskSealSchema.optional(),
  /**
   * How many deliveries the task took, when more than one (#207): it was retried after a failure,
   * or recovered after a crashed or abandoned run.
   */
  attempts: z
    .number()
    .int()
    .min(2)
    .optional()
    .describe('Deliveries this task took when more than one: it was retried or recovered after a failure.')
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

/** A follow-up an outcome asked for (runner `TaskFollowUp`), as a task's checkpoint keeps it. */
export const AgentFollowUpSchema = z.object({
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  delayMs: z.number().int().min(0).optional(),
  chatDriven: z.boolean().optional()
});
export type AgentFollowUp = z.infer<typeof AgentFollowUpSchema>;

/**
 * A task's result, checkpointed once its action is carried out and before anything else (#207):
 * a retry after a crash finishes from here (memory, follow-ups, the record) instead of deciding
 * and acting again.
 */
export const AgentTaskPendingSchema = AgentTaskRecordSchema.pick({
  status: true,
  fallbackReason: true,
  toolsCalled: true,
  finalAction: true,
  reasoningSummary: true,
  usage: true,
  sealed: true
}).extend({ followUps: z.array(AgentFollowUpSchema).default([]) });
export type AgentTaskPending = z.infer<typeof AgentTaskPendingSchema>;

/**
 * The claim on a task id (#207). `started` carries the attempt (1 on the first delivery, one more
 * on every takeover: the fencing token later writes must match), the mutations earlier attempts
 * reached (`effects`), and the checkpointed result, if an earlier attempt got that far.
 */
export type AgentTaskClaim =
  | { status: 'started'; attempt: number; effects: number; pending: AgentTaskPending | null }
  | { status: 'done'; record: AgentTaskRecord }
  | { status: 'in_progress' };

export interface AgentTaskClaimInput {
  taskId: string;
  now: Date;
  lockUntil: Date;
  /** The `Agent Action Requested` detail, kept so recovery can deliver it again. */
  request?: Record<string, unknown>;
}

/** Which attempt a write is for: it lands only while that attempt still holds the task. */
export interface AgentTaskFence {
  taskId: string;
  attempt: number;
}

/** A claimed task whose lease ran out (crashed or abandoned), or a failed one waiting for its retry. */
export interface AgentTaskLease {
  taskId: string;
  attempt: number;
  /** Epoch ms. */
  lockUntil: number;
  /** The request to deliver again; null for a claim made before #207. */
  request: Record<string, unknown> | null;
}

export const AGENT_DISPATCH_STATES = ['reserved', 'dispatched', 'abandoned'] as const;

/**
 * One task on its way to the runner (#207): the dispatch outbox. `reserved` once admitted (the
 * cooldown spent, the request fixed), `dispatched` once published or scheduled, `abandoned` when
 * every send failed. The relay resends reserved ones from `retryAt` on.
 */
export interface AgentDispatch {
  taskId: string;
  leagueId: string;
  /** The `Agent Action Requested` detail. */
  request: Record<string, unknown>;
  /** When a delayed task runs (ISO), fixed at reservation; null publishes it right away. */
  at: string | null;
  delayMs: number;
  state: (typeof AGENT_DISPATCH_STATES)[number];
  /** Failed sends so far. */
  attempts: number;
  reservedAt: string;
  /** From when the relay may send it (ISO), while reserved. */
  retryAt: string;
}

export type AgentDispatchReservation =
  { status: 'reserved' } | { status: 'exists'; dispatch: AgentDispatch } | { status: 'gated' };

/**
 * An admission gate on a trigger-state slot (#207): taken by `owner` when the slot is free, already
 * the owner's (a redelivery gets the same answer), or last taken at least `windowMs` ago (null:
 * never again, a once-per key; 0: always, whatever the clocks say, as urgent triggers do). Taking
 * it records `now` and the owner, atomically.
 */
export interface TriggerGate {
  slot: string;
  owner: string;
  now: Date;
  windowMs: number | null;
}

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

  /**
   * Claims a task id: once per trigger, with takeover after `lockUntil` if a run crashed, or at
   * once when it waits for a retry (`releaseTask`, `requeueTaskLease`). Each claim is a new attempt.
   */
  claimTask(input: AgentTaskClaimInput): Promise<AgentTaskClaim>;
  /**
   * Stores the finished task record (and makes it listable). With a fence, only while that attempt
   * holds the task: false when a newer attempt took it over (the record is not written).
   */
  completeTask(record: AgentTaskRecord, expiresAt: Date, fence?: AgentTaskFence): Promise<boolean>;
  /** Counts a mutation about to be made, if the attempt still holds the task (false: fenced off). */
  recordTaskEffect(fence: AgentTaskFence): Promise<boolean>;
  /** Checkpoints the task's result (see `AgentTaskPending`), if the attempt still holds the task. */
  saveTaskPending(fence: AgentTaskFence, pending: AgentTaskPending): Promise<boolean>;
  /** Gives the task back for a retry from `retryAt` (a retryable failure), if the attempt holds it. */
  releaseTask(fence: AgentTaskFence, retryAt: Date, reason: string): Promise<boolean>;
  /** Claimed tasks whose lease or retry time is at or before `now`, oldest first. */
  listExpiredTaskLeases(now: Date, limit: number): Promise<AgentTaskLease[]>;
  /**
   * Marks an expired lease as waiting for a retry, holding it off until `until`, if it is still
   * the lease the caller saw (`lockUntil`): so two sweeps never requeue it twice.
   */
  requeueTaskLease(lease: Pick<AgentTaskLease, 'taskId' | 'lockUntil'>, until: Date): Promise<boolean>;
  /** Newest first. */
  listTasks(leagueId: string, query?: { teamId?: string; limit?: number }): Promise<AgentTaskRecord[]>;

  /** Adds to the weekly rollup row for (league, week, agent, model). */
  addUsage(row: AgentUsageRow): Promise<void>;
  weekUsage(leagueId: string, week: number): Promise<AgentUsageRow[]>;

  getTriggerState(leagueId: string, agentId: string): Promise<AgentTriggerState | null>;
  putTriggerState(state: AgentTriggerState): Promise<void>;
  /** Takes a trigger-state slot through its gate, atomically (see `TriggerGate`). */
  admitTrigger(leagueId: string, gate: TriggerGate): Promise<boolean>;

  /**
   * Reserves a dispatch (`dispatch.state` is `reserved`), and with a gate takes the gate in the same
   * transaction: `gated` when the gate is closed (nothing written), `exists` when the task already
   * has a dispatch (a redelivery, or a racing one).
   */
  reserveDispatch(dispatch: AgentDispatch, gate?: TriggerGate): Promise<AgentDispatchReservation>;
  getDispatch(taskId: string): Promise<AgentDispatch | null>;
  /** Marks a dispatch sent (`dispatched`) or given up (`abandoned`). */
  settleDispatch(taskId: string, state: 'dispatched' | 'abandoned'): Promise<void>;
  /** Counts a failed send and holds the next one off until `retryAt`. Returns the failures so far. */
  failDispatch(taskId: string, retryAt: Date): Promise<number>;
  /** Reserved dispatches whose `retryAt` is at or before `now`, oldest first. */
  listDueDispatches(now: Date, limit: number): Promise<AgentDispatch[]>;
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

/** The latest `lastTriggeredAt` (ISO, which sorts as time) that leaves a windowed gate open. */
export function gateCutoff(gate: TriggerGate & { windowMs: number }): string {
  return new Date(gate.now.getTime() - gate.windowMs).toISOString();
}
