import {
  RESEARCH_KINDS,
  SOCIAL_LIMITS,
  agendaPrompt,
  estimateCostUsd,
  getModel,
  resolveAgentConfig,
  situationPrompt,
  memoryForAudience,
  summarizeMemory,
  type MemoryEvent,
  type ModelKey,
  type ReasoningEffort,
  type ResearchAccess
} from '@fantasy/core';
import {
  agentPrincipal,
  budgetWeek,
  isApiError,
  leagueBudget,
  roundUsd,
  taskCountKey,
  usageKey,
  type AgentFollowUp,
  type AgentModelUsage,
  type AgentTaskFence,
  type AgentTaskPending,
  type AgentTaskRecord,
  type AgentTaskSeal,
  type AgentUsageEntry,
  type BudgetHold,
  type League,
  type LeagueBudget,
  type Logger,
  type Registry,
  type Services
} from '@fantasy/server';
import { ZodError } from 'zod';
import { dispatchTask, errorName, providerErrorDetail } from './dispatch.js';
import type { AgentActionRequested } from './events.js';
import type { AgentAblation } from './ablations.js';
import { refreshAgenda } from './agenda.js';
import { effectiveBehavior, readSituation } from './situation.js';
import { ATTACHMENT_KINDS, refreshAttachments } from './attachments.js';
import { commitmentAccess } from './commitments.js';
import { socialActAccess } from './social-acts.js';
import type { ScriptedRequestExtras } from './fake-model.js';
import type { KillSwitch } from './kill-switch.js';
import {
  MEMORY_BUDGETS,
  defaultAudience,
  memoryForPrompt,
  recallFocus,
  outcomeVisibility,
  sealChecker,
  sealWithMemory,
  tableMemoryStore,
  type AgentMemoryStore
} from './memory.js';
import {
  estimateTokens,
  isModelUnavailable,
  isOutputLimit,
  runUsageOf,
  type ModelClient,
  type ModelRunResult,
  type ModelUsage
} from './model.js';
import { MEMORY_NOTE_MAX, assembleSystemPrompt } from './prompt.js';
import { taskIdFor } from './router.js';
import type {
  BaseDecision,
  AgendaMode,
  PreparedTask,
  TaskContext,
  TaskKindRegistry,
  TaskOutcome
} from './tasks/kinds.js';
import { TaskUnavailableError } from './tasks/lineup.js';
import { ToolBox, keyPrefix } from './tools.js';

/**
 * Runs one `Agent Action Requested` task in the Lambda (issue #41). In order:
 *
 * 1. Claim the task id (idempotent per trigger event: a redelivery returns the stored record). Each
 *    claim is an attempt; its number fences every later write (#207).
 * 2. Load the league and seat, resolve the config, and let the task kind prepare.
 * 3. Decide the mode: deterministic fallback if the kill switch is on or the league's weekly budget
 *    is spent; otherwise the model, trying each model in the tier's chain. Each model call is
 *    admitted against the budget first (#209, below); a call that does not fit falls back.
 * 4. On a model timeout or failure, fall back to the kind's deterministic behavior. The failed run
 *    still counts against the budget: what the provider reported for the turns it finished, or an
 *    estimate from the prompt and the token limit when it reported nothing.
 * 5. Checkpoint the result (`saveTaskPending`), then record everything (#45): trigger, tools called,
 *    final action, reasoning summary, latency, tokens and estimated cost per model; count the task
 *    in the weekly rollups; update the agent's memory (#44): its decision, its note, and whatever the
 *    kind adds (a chat snapshot). Summaries with sealed information carry the kind's `sealed`
 *    marker, so the activity log withholds them (#122).
 * 6. Dispatch the outcome's follow-up tasks (`followUps`) through the outbox (dispatch.ts), each a
 *    task of its own for the same agent. Chat-driven ones (#196, a conversation handed to an action
 *    task) are held to `SOCIAL_LIMITS.chatActionsPerDay` per agent (`takeChatActionSlot`).
 *
 * The task lifecycle (#207):
 *
 * - Expected no-ops (a stale trigger, `TaskUnavailableError`; a missing league, seat, or kind) are
 *   `skipped`. Permanent failures (bugs, invalid input: `failureClass`) are `failed` at once.
 *   Retryable ones (throttling, timeouts, a 5xx, a conflict) give the task back for a retry after
 *   `taskRetryDelayMs` (`releaseTask`); the recovery sweep (recovery.ts) delivers it again, and after
 *   `TASK_ATTEMPTS` deliveries it is `failed` as `retries_exhausted`.
 * - A worker that crashes or stalls keeps its lease until `TASK_LOCK_MS`; the recovery sweep then
 *   delivers the task again, without waiting for another event.
 * - Partial effects are reconciled, not replayed: every mutation is counted under the attempt's
 *   fence first (`recordTaskEffect`), so a retry knows whether an earlier attempt acted. If it did,
 *   the model never runs again (its actions were not deterministic); the kind prepares from the
 *   league as it is now and its deterministic fallback finishes the job (`recovered`), with the
 *   same idempotency keys, so a deterministic step already done replays instead of acting twice. An
 *   attempt that got as far as its checkpoint finishes from it: memory is left as it was, follow-ups
 *   are dispatched (idempotently, by task id), and the record is written.
 * - A stale attempt cannot overwrite a newer one: its mutations are refused (the ToolBox fence), its
 *   checkpoint and record are not written, and it only adds the usage it spent.
 *
 * Spend (#209): the weekly ceiling is a soft threshold with a bounded overshoot, and admission to it
 * is atomic. Before each model call the attempt holds the call's estimate (the prompt and the whole
 * response limit) against the ceiling (`reserveBudget`): only while recorded spend, every hold, and
 * this one fit, so racing tasks cannot all pass the same room. Right after the call its usage
 * replaces the hold in one transaction (`recordUsage`: the provider's count, or an estimate when it
 * reported none, flagged `estimatedTokens`); a call that never ran releases it. Usage goes through a
 * ledger keyed by task, attempt, and call (`usageKey`), and a finished task is counted under its
 * own keys (`taskCountKey`), so writing a line again never counts it twice: a usage write that fails
 * is retried when the attempt ends, and a delivery of a finished task writes its record's lines
 * again, which repairs a charge lost after completion. A hold whose attempt died is charged as its
 * estimate by the recovery sweep once the attempt's lease has run out. See docs/ARCHITECTURE.md
 * (Spend guard) for the overshoot bound.
 *
 * The first task that finds the league's weekly budget spent announces it in the league chat
 * (`Agent Budget Exceeded`, once per league and budget week).
 */

export interface RunnerDeps {
  registry: Registry;
  services: Services;
  kinds: TaskKindRegistry;
  model: ModelClient;
  killSwitch: KillSwitch;
  /** Wall-clock budget for the model part of a task. */
  modelTimeoutMs?: number;
  /** Where agent memory lives; defaults to the league table. */
  memory?: AgentMemoryStore;
  /** State switched off for an evaluation (ablations.ts); production passes none. */
  ablations?: readonly AgentAblation[];
}

/** How long a crashed run blocks a retry of the same task (its lease). */
export const TASK_LOCK_MS = 5 * 60 * 1000;
/** Deliveries of one task that may run; one more records it as failed (`retries_exhausted`). */
export const TASK_ATTEMPTS = 3;
/** How long task records are kept. */
export const TASK_RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Mutations deterministic code may make in one task. */
export const DETERMINISTIC_ACTIONS = 10;

/** Wait before the next delivery after a retryable failure of attempt `attempt`: 1, 2, 4 minutes. */
export function taskRetryDelayMs(attempt: number): number {
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

const MAX_TOKENS: Record<ReasoningEffort, number> = { low: 1024, medium: 2048, high: 4096 };

/**
 * Extra response room by reasoning effort for catalog models that reason in their visible output
 * (`reasoningInOutput`), whose reasoning would otherwise use up `MAX_TOKENS` before they answer.
 */
export const OUTPUT_REASONING_ROOM: Readonly<Record<ReasoningEffort, number>> = {
  low: 2048,
  medium: 4096,
  high: 6144
};

/**
 * Extended-thinking budget by reasoning effort, for catalog models that take one
 * (`thinkingBudget`). Low effort does not think; the response limit grows by the budget.
 */
export const THINKING_BUDGET: Readonly<Record<ReasoningEffort, number>> = {
  low: 0,
  medium: 1024,
  high: 4096
};

const FULL_RESEARCH = Object.fromEntries(RESEARCH_KINDS.map((k) => [k, true])) as ResearchAccess;

/** Error names (or codes) of failures worth another try: throttling, timeouts, dropped connections. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'TransactionConflictException',
  'InternalServerError',
  'InternalFailure',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN'
]);
/** API error codes that may pass on a retry (the rest are deterministic answers). */
const TRANSIENT_API_CODES: ReadonlySet<string> = new Set([
  'INTERNAL',
  'CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED'
]);

/**
 * Whether a task failure may pass on another delivery (`retryable`: throttling, timeouts, dropped
 * connections, a 5xx or conflict from an operation, any AWS SDK error it marks retryable) or will
 * fail the same way again (`permanent`: invalid input, a bug, a 4xx answer).
 */
export function failureClass(error: unknown): 'retryable' | 'permanent' {
  if (isApiError(error)) return TRANSIENT_API_CODES.has(error.code) ? 'retryable' : 'permanent';
  if (error instanceof ZodError || !(error instanceof Error)) return 'permanent';
  const sdk = error as Error & { $retryable?: unknown; code?: unknown };
  if (sdk.$retryable !== undefined && sdk.$retryable !== null) return 'retryable';
  return TRANSIENT_ERRORS.has(error.name) || (typeof sdk.code === 'string' && TRANSIENT_ERRORS.has(sdk.code))
    ? 'retryable'
    : 'permanent';
}

export async function runAgentAction(
  deps: RunnerDeps,
  request: AgentActionRequested
): Promise<AgentTaskRecord> {
  const { services } = deps;
  const { agents } = services.repos;
  const clock = services.clock;
  const log = services.log.child({ taskId: request.taskId, kind: request.kind, teamId: request.teamId });
  const started = clock.now();

  const claim = await agents.claimTask({
    taskId: request.taskId,
    now: started,
    lockUntil: new Date(started.getTime() + TASK_LOCK_MS),
    request
  });
  if (claim.status === 'done') {
    log.info('agent task already done; replaying', { status: claim.record.status });
    // Charging is idempotent: this repairs a usage write that failed after the record was stored.
    await new TaskAttempt(deps, request, null, started, log, claim.record.week).charge(
      claim.record.usage,
      true
    );
    return claim.record;
  }
  if (claim.status === 'in_progress') {
    log.info('agent task already running elsewhere');
    return new TaskAttempt(deps, request, null, started, log, 0).report(skipped('in_progress'));
  }
  if (claim.attempt > 1) {
    log.info('agent task delivered again', {
      attempt: claim.attempt,
      effects: claim.effects,
      checkpointed: claim.pending !== null
    });
  }

  const league = await services.repos.leagues.get(request.leagueId);
  const seat = league === null ? null : await agents.getSeat(request.leagueId, request.teamId);
  const kind = deps.kinds.get(request.kind);
  const week = league === null ? 0 : budgetWeek(league);
  const fence: AgentTaskFence = { taskId: request.taskId, attempt: claim.attempt };
  const attempt = new TaskAttempt(deps, request, fence, started, log, week);
  if (league === null || seat === null || seat.agentId !== request.agentId || kind === undefined) {
    const reason =
      league === null
        ? 'league_not_found'
        : seat === null || seat.agentId !== request.agentId
          ? 'no_agent_seat'
          : 'unknown_kind';
    return attempt.finish(skipped(reason));
  }
  if (claim.attempt > TASK_ATTEMPTS) {
    log.warn('agent task gave up: every attempt failed', { attempt: claim.attempt });
    return attempt.finish({
      ...skipped('retries_exhausted'),
      status: 'failed',
      reasoningSummary: `Gave up after ${TASK_ATTEMPTS} attempts failed.`
    });
  }
  if (claim.pending !== null) {
    log.info('agent task finishing from its checkpoint', { attempt: claim.attempt });
    return attempt.conclude(claim.pending, league.id, seat.agentId);
  }

  const principal = agentPrincipal({ agentId: seat.agentId, teamId: seat.teamId, leagueId: league.id });
  const config = resolveAgentConfig(seat.config, { managerKey: seat.agentId });
  const memoryStore = deps.memory ?? tableMemoryStore(agents);
  const prefix = keyPrefix(request.taskId);
  const beforeMutation = () => agents.recordTaskEffect(fence);
  const system = new ToolBox({
    registry: deps.registry,
    services,
    principal,
    research: FULL_RESEARCH,
    actionsPerTrigger: DETERMINISTIC_ACTIONS,
    idempotencyPrefix: `${prefix}:sys`,
    beforeMutation
  });
  attempt.toolboxes.push(system);
  const leagueId = league.id;
  const claimUse = async (key: string, name: string, cap: number, windowMs: number): Promise<boolean> => {
    const result = await agents.claimLimit({ leagueId, key, now: clock.now(), windowMs, cap });
    if (result === 'contended') log.warn('agent limit contended; treated as used up', { limit: name });
    return result === 'claimed';
  };
  const off = new Set(deps.ablations ?? []);
  const ctx: TaskContext = {
    taskId: request.taskId,
    principal,
    league,
    seat,
    config,
    tools: system,
    clock,
    log,
    trigger: { detailType: request.trigger.detailType, eventId: request.trigger.eventId },
    ...(off.has('no_agenda_commitments')
      ? {}
      : { commitments: commitmentAccess(services, league.id, seat.agentId, seat.teamId) }),
    ...(off.has('no_social_acts')
      ? {}
      : { socialActs: socialActAccess(services, league.id, seat.agentId, seat.teamId) }),
    ...(off.size === 0 ? {} : { ablations: off }),
    recall: async (audience) => {
      const memory = await memoryStore.load(league.id, seat.agentId);
      const sealed = await sealChecker(services, league.id, memory);
      return memoryForAudience(memoryForPrompt(memory, 'decision'), audience, sealed).memory;
    },
    claimLimit: (name, cap, windowMs) => claimUse(`${seat.agentId}#${name}`, name, cap, windowMs),
    claimShared: (name, cap, windowMs) => claimUse(`league#${name}`, name, cap, windowMs),
    claimOnce: (name, windowMs) =>
      agents.admitTrigger(leagueId, {
        slot: `${seat.agentId}#once#${name}`,
        owner: request.taskId,
        now: clock.now(),
        windowMs
      })
  };

  // One read of the stakes feeds both the deterministic levers and the prompt (#217).
  if (!off.has('no_situation')) ctx.situation = await readSituation(services, ctx);
  if (ctx.situation !== undefined) {
    const { urgency, basis, reasons, sinceWeek, previous, pending, week, throughWeek, pressure } =
      ctx.situation;
    log.info('agent situation', {
      week,
      throughWeek,
      // Positions short or thin (#248 counts roster-pressure exposure).
      pressure: Object.entries(pressure)
        .filter(([, p]) => p !== 'covered')
        .map(([position, p]) => `${position}:${p}`),
      urgency,
      basis,
      reasons,
      sinceWeek,
      previous,
      pending,
      adjustments: effectiveBehavior(ctx).explanation
    });
  }
  const situation = situationPrompt(ctx.situation);

  let agendaMode: AgendaMode = 'none';
  let prepared: PreparedTask;
  try {
    agendaMode = off.has('no_agenda_commitments') ? 'none' : kind.agendaMode(ctx, request.payload);
    if (agendaMode !== 'none') {
      const agenda = await refreshAgenda(services, ctx);
      if ((agendaMode === 'private' || agendaMode === 'guide_only') && agenda !== undefined)
        ctx.agenda = agenda;
    }
    if (ATTACHMENT_KINDS.has(kind.kind) && !off.has('no_attachments')) {
      const attachments = await refreshAttachments(services, ctx);
      if (attachments !== undefined) ctx.attachments = attachments;
    }
    prepared = await kind.prepare(ctx, request.payload);
  } catch (error) {
    if (error instanceof TaskUnavailableError) {
      // Work it hands on anyway (#215) is dispatched idempotently, by task id, before the record.
      if (error.followUps !== undefined && error.followUps.length > 0) {
        try {
          await attempt.dispatchFollowUps(error.followUps, league.id, seat.agentId);
        } catch (dispatchError) {
          return attempt.retryLater('follow_ups', dispatchError, []);
        }
      }
      return attempt.finish({
        ...skipped(error.message),
        toolsCalled: [...system.calls],
        ...(error.sealed === undefined ? {} : { sealed: error.sealed }),
        ...(error.summary === undefined ? {} : { reasoningSummary: error.summary })
      });
    }
    return attempt.failed('prepare', error, {
      ...skipped('prepare_failed'),
      status: 'failed',
      toolsCalled: [...system.calls],
      reasoningSummary: `Could not prepare the task (${errorName(error)}).`
    });
  }

  const audience = prepared.memoryAudience ?? defaultAudience(kind.modelRole, prepared.memoryScope);
  attempt.remember = async (outcome: TaskOutcome, note?: string) => {
    // Only a new authoritative snapshot can finish a goal; pending offers/claims do not.
    if (agendaMode !== 'none' && system.actionsTaken > 0) await refreshAgenda(services, ctx);
    const events: MemoryEvent[] = [];
    // The decision and its note are as private as the task's summary (#206).
    const visibility = outcomeVisibility(outcome.sealed, audience);
    // Chat summaries come from reading other people's messages: never kept as the agent's own record.
    if (kind.modelRole === 'decision' && outcome.action !== 'none') {
      events.push({
        type: 'decision',
        kind: kind.kind,
        action: outcome.action,
        summary: outcome.memorySummary ?? outcome.summary,
        at: clock.now().toISOString(),
        visibility
      });
    }
    if (
      note !== undefined &&
      note.trim().length > 0 &&
      kind.modelRole === 'decision' &&
      kind.modelNotes !== false
    ) {
      events.push({
        type: 'note',
        text: note.trim().slice(0, MEMORY_NOTE_MAX),
        at: clock.now().toISOString(),
        visibility
      });
    }
    // A chat kind keeps only chat: its room snapshot and relationship notes, never a decision,
    // note, or trade record that later prompts would treat as the agent's own.
    events.push(
      ...(outcome.memory ?? []).filter(
        (e) => kind.modelRole === 'decision' || e.type === 'chat' || e.type === 'relationship'
      )
    );
    if (events.length === 0) return;
    try {
      await memoryStore.remember(league.id, seat.agentId, events);
    } catch (error) {
      // Memory is best effort: a failed write never undoes or fails the decision.
      log.warn('agent memory write failed', { error: errorName(error) });
    }
  };
  attempt.owner = { leagueId: league.id, agentId: seat.agentId };

  // An earlier attempt acted: reconcile from the league as it is now, never replay the model.
  if (claim.effects > 0) {
    log.warn('agent task recovering after partial effects', {
      attempt: claim.attempt,
      effects: claim.effects
    });
    return attempt.fallback(prepared, 'recovered');
  }

  const gate = await modeGate(deps, league);
  if (typeof gate === 'string') return attempt.fallback(prepared, gate);

  const modelTools = new ToolBox({
    registry: deps.registry,
    services,
    principal,
    research: config.levers.research,
    ...((prepared.tools ?? kind.tools) === undefined ? {} : { allow: prepared.tools ?? kind.tools }),
    actionsPerTrigger: kind.modelActions ?? config.levers.actionsPerTrigger,
    idempotencyPrefix: prefix,
    beforeMutation
  });
  attempt.toolboxes.unshift(modelTools);
  const [memory, teams] = await Promise.all([
    memoryStore.load(league.id, seat.agentId),
    services.repos.teams.list(league.id)
  ]);
  // Only what the task's readers may know reaches the prompt (#206); what private memory it keeps
  // extends the task's seal, since the model's words may repeat it.
  const heard = memoryForAudience(
    memoryForPrompt(memory, kind.modelRole, prepared.memoryScope),
    audience,
    await sealChecker(services, league.id, memory)
  );
  const sealHeard = (outcome: TaskOutcome): TaskOutcome => {
    const sealed = sealWithMemory(outcome.sealed, heard.seals, kind.title);
    return sealed === undefined ? outcome : { ...outcome, sealed };
  };
  const systemPrompt = assembleSystemPrompt({
    config,
    league,
    teamId: seat.teamId,
    memory: summarizeMemory(heard.memory, {
      tokenBudget: MEMORY_BUDGETS[config.levers.reasoningEffort],
      teamName: (id) => teams.find((t) => t.id === id)?.name ?? id,
      now: clock.now().toISOString(),
      focus: recallFocus(kind, prepared, audience)
    }),
    task: {
      title: kind.title,
      instructions: [
        ...(agendaMode !== 'private' || ctx.agenda === undefined || agendaPrompt(ctx.agenda).length === 0
          ? []
          : [
              'Your current private roster priorities (do not disclose private plans):',
              ...agendaPrompt(ctx.agenda)
            ]),
        // League-visible facts only, so chat and decisions say the same thing the code does.
        ...(situation.length === 0 ? [] : ['Your competitive situation (from final results):', ...situation]),
        prepared.instructions
      ].join('\n')
    }
  });
  const chain: ModelKey[] = kind.modelRole === 'chat' ? config.models.chat : config.models.decision;
  const usage: AgentModelUsage[] = [];
  let lastError: unknown = null;
  const effort = config.levers.reasoningEffort;
  const input = `Trigger: ${request.trigger.detailType}. Do the current task, then give your structured answer.`;
  let call = 0;
  for (const modelKey of chain) {
    const model = getModel(modelKey);
    const thinking = model.thinkingBudget === true ? THINKING_BUDGET[effort] : 0;
    const room = model.reasoningInOutput === true ? OUTPUT_REASONING_ROOM[effort] : 0;
    const maxTokens = MAX_TOKENS[effort] + thinking + room;
    // One turn at the response limit: held while the call runs, and charged for a failed run the
    // provider reported nothing for.
    const estimate = { inputTokens: estimateTokens(systemPrompt + input), outputTokens: maxTokens };
    call++;
    const refused = await attempt.reserve(modelKey, call, estimate, gate.ceilingUsd);
    if (refused !== null) return attempt.fallback(prepared, refused, usage);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('agent task timed out')),
      deps.modelTimeoutMs ?? 90_000
    );
    let result: ModelRunResult<BaseDecision>;
    try {
      const runRequest = {
        modelId: model.bedrockId,
        systemPrompt,
        input,
        tools: modelTools.tools,
        maxIterations: config.levers.maxToolSteps,
        maxTokens,
        ...(thinking > 0
          ? model.adaptiveThinking === true
            ? { thinkingEffort: effort as 'medium' | 'high' }
            : { thinkingBudgetTokens: thinking }
          : {}),
        temperature: kind.modelRole === 'chat' ? 0.8 : 0.4,
        outputSchema: prepared.decision,
        signal: controller.signal,
        invocationState: {
          taskId: request.taskId,
          agentId: seat.agentId,
          teamId: seat.teamId,
          leagueId: league.id
        },
        ...(prepared.fakeScript === undefined ? {} : { fakeScript: prepared.fakeScript })
      } satisfies Parameters<ModelClient['run']>[0] & ScriptedRequestExtras;
      result = await deps.model.run<BaseDecision>(runRequest);
    } catch (error) {
      lastError = error;
      const timedOut = controller.signal.aborted;
      const detail = providerErrorDetail(error);
      log.warn('agent model run failed', { model: modelKey, timedOut, error: detail });
      // What the provider reported for the turns the run finished, if it reported anything.
      const spent = runUsageOf(error);
      if (!timedOut && isModelUnavailable(error) && modelTools.actionsTaken === 0) {
        if (spent === null) await attempt.release(call);
        else usage.push(await attempt.settleCall(modelKey, call, spent));
        continue;
      }
      // Out of response room before it acted: the next model may answer in less. What this run
      // spent is charged, the estimate when the provider reported nothing.
      if (!timedOut && isOutputLimit(error) && modelTools.actionsTaken === 0) {
        usage.push(await attempt.settleCall(modelKey, call, spent ?? { ...estimate, estimated: true }));
        continue;
      }
      // The run got far enough to cost something: without a reported count, the estimate is
      // charged, so failures cannot slip past the weekly budget.
      usage.push(await attempt.settleCall(modelKey, call, spent ?? { ...estimate, estimated: true }));
      return attempt.fallback(prepared, timedOut ? 'timeout' : 'model_error', usage, detail);
    } finally {
      clearTimeout(timer);
    }
    usage.push(await attempt.settleCall(modelKey, call, result.usage));
    const decision = result.decision;

    let outcome: TaskOutcome;
    try {
      outcome = sealHeard(await prepared.apply(decision));
    } catch (error) {
      if (attempt.fenced) return attempt.discard(attempt.failedResult('apply', error, null, usage));
      // A no-op found only at apply time (another task answered first): skipped, nothing acted.
      if (error instanceof TaskUnavailableError && attempt.actionsTaken === 0)
        return attempt.finish({ ...skipped(error.message), toolsCalled: attempt.calls(), usage });
      // After an action, or on a failure that may pass: retry, and reconcile then. Otherwise the
      // decision itself is unusable, and the deterministic fallback decides instead.
      if (attempt.actionsTaken > 0 || failureClass(error) === 'retryable') {
        return attempt.retryLater('apply', error, usage);
      }
      log.warn('agent decision could not be applied; falling back', { error: errorName(error) });
      return attempt.fallback(prepared, 'apply_failed', usage);
    }
    return attempt.settle(
      {
        status: 'completed',
        fallbackReason: null,
        toolsCalled: attempt.calls(),
        finalAction: outcome.action,
        reasoningSummary: outcome.summary,
        usage,
        ...(outcome.sealed === undefined ? {} : { sealed: outcome.sealed })
      },
      outcome,
      decision.memoryNote
    );
  }
  const detail = lastError === null ? undefined : providerErrorDetail(lastError);
  // The last model ran out of response room rather than being unavailable: say which.
  const reason = isOutputLimit(lastError) ? 'max_tokens' : 'models_unavailable';
  log.warn('no model in the chain answered', { chain, reason, error: detail ?? null });
  return attempt.fallback(prepared, reason, usage, detail);
}

/** The fallback reason when the model may not run; otherwise the week's budget. */
async function modeGate(deps: RunnerDeps, league: League): Promise<string | LeagueBudget> {
  if (await deps.killSwitch.engaged()) return 'kill_switch';
  const budget = await leagueBudget(deps.services.repos.agents, league);
  if (budget.exceeded) {
    deps.services.log.warn('league agent budget exceeded; using deterministic fallbacks', {
      leagueId: league.id,
      week: budget.week,
      spentUsd: budget.spentUsd,
      ceilingUsd: budget.ceilingUsd
    });
    await announceBudget(deps, league, budget);
    return 'budget_exceeded';
  }
  return budget;
}

/**
 * Tells the league, once per budget week, that its agents are on autopilot (#93). The trigger-state
 * slot marks the week as announced once the event is out; a task racing this one could announce it
 * twice, which only repeats a chat line.
 */
async function announceBudget(deps: RunnerDeps, league: League, budget: LeagueBudget): Promise<void> {
  const { agents } = deps.services.repos;
  const slot = `league#budget-notice#week-${budget.week}`;
  if ((await agents.getTriggerState(league.id, slot)) !== null) return;
  await deps.services.events.publish('Agent Budget Exceeded', {
    leagueId: league.id,
    week: budget.week,
    spentUsd: budget.spentUsd,
    ceilingUsd: budget.ceilingUsd
  });
  await agents.putTriggerState({
    leagueId: league.id,
    agentId: slot,
    lastTriggeredAt: deps.services.clock.now().toISOString()
  });
}

type Result = Pick<
  AgentTaskRecord,
  'status' | 'fallbackReason' | 'errorDetail' | 'toolsCalled' | 'finalAction' | 'reasoningSummary' | 'usage'
> & { sealed?: AgentTaskSeal };

function skipped(reason: string): Result {
  return {
    status: 'skipped',
    fallbackReason: reason,
    toolsCalled: [],
    finalAction: 'none',
    reasoningSummary: `Skipped: ${reason}.`,
    usage: []
  };
}

/**
 * One attempt at a task: what it knows about itself (the fence, the tool boxes, the agent) and the
 * ways it ends — finished and recorded, given back for a retry, or fenced off by a newer attempt.
 */
class TaskAttempt {
  /** Model tools first, then the deterministic ones. */
  readonly toolboxes: ToolBox[] = [];
  /** Writes the outcome to the agent's memory (set once the kind has prepared). */
  remember: ((outcome: TaskOutcome, note?: string) => Promise<void>) | null = null;
  /** Whose follow-ups these are (set with `remember`; a checkpoint passes its own). */
  owner: { leagueId: string; agentId: string } | null = null;
  /** Budget holds of this attempt's model calls not settled yet, by ledger key (#209). */
  readonly #holds = new Map<string, BudgetHold>();
  /** Ledger keys this attempt has charged. */
  readonly #charged = new Set<string>();

  constructor(
    readonly deps: RunnerDeps,
    readonly request: AgentActionRequested,
    readonly fence: AgentTaskFence | null,
    readonly started: Date,
    readonly log: Logger,
    readonly week: number
  ) {}

  get services(): Services {
    return this.deps.services;
  }

  /** True once a mutation was refused: a newer attempt holds the task. */
  get fenced(): boolean {
    return this.toolboxes.some((t) => t.fenced);
  }

  get actionsTaken(): number {
    return this.toolboxes.reduce((sum, t) => sum + t.actionsTaken, 0);
  }

  calls() {
    return this.toolboxes.flatMap((t) => t.calls);
  }

  /** Runs the kind's deterministic fallback and settles its outcome (`errorDetail`: why the model failed). */
  async fallback(
    prepared: PreparedTask,
    reason: string,
    usage: AgentModelUsage[] = [],
    errorDetail?: string
  ): Promise<AgentTaskRecord> {
    const detail = errorDetail === undefined ? {} : { errorDetail };
    let outcome: TaskOutcome;
    try {
      outcome = await prepared.fallback();
    } catch (error) {
      return this.failed('fallback', error, {
        ...this.failedResult('fallback', error, reason, usage),
        ...detail
      });
    }
    return this.settle(
      {
        status: 'fallback',
        fallbackReason: reason,
        ...detail,
        toolsCalled: this.calls(),
        finalAction: outcome.action,
        reasoningSummary: outcome.summary,
        usage,
        ...(outcome.sealed === undefined ? {} : { sealed: outcome.sealed })
      },
      outcome
    );
  }

  /**
   * The action is done: checkpoint the result, then remember, dispatch follow-ups, and record it.
   * A crash after the checkpoint resumes from it (`conclude`) and never acts again.
   */
  async settle(result: Result, outcome: TaskOutcome, note?: string): Promise<AgentTaskRecord> {
    if (this.fenced || this.fence === null) return this.discard(result);
    const pending: AgentTaskPending = { ...result, followUps: outcome.followUps ?? [] };
    if (!(await this.services.repos.agents.saveTaskPending(this.fence, pending))) return this.discard(result);
    await this.remember?.(outcome, note);
    const owner = this.owner as { leagueId: string; agentId: string };
    return this.conclude(pending, owner.leagueId, owner.agentId);
  }

  /** Dispatches a checkpoint's follow-ups and records the task. */
  async conclude(pending: AgentTaskPending, leagueId: string, agentId: string): Promise<AgentTaskRecord> {
    const { followUps, ...result } = pending;
    try {
      await this.dispatchFollowUps(followUps, leagueId, agentId);
    } catch (error) {
      // The checkpoint holds the follow-ups: the retry dispatches them without acting again.
      return this.retryLater('follow_ups', error, []);
    }
    return this.finish(result);
  }

  /**
   * Each follow-up is a task of its own, reserved in the outbox under an id from the trigger and its
   * kind, so a retry or a redelivery never doubles it. A chat-driven one spends a daily use only
   * when it is reserved the first time.
   */
  async dispatchFollowUps(
    followUps: readonly AgentFollowUp[],
    leagueId: string,
    agentId: string
  ): Promise<void> {
    const { services, request } = this;
    for (const next of followUps) {
      const task: AgentActionRequested = {
        ...request,
        taskId: taskIdFor(request.trigger.eventId, request.teamId, next.kind),
        kind: next.kind,
        payload: next.payload,
        requestedAt: services.clock.now().toISOString()
      };
      if (
        next.chatDriven === true &&
        (await services.repos.agents.getDispatch(task.taskId)) === null &&
        !(await takeChatActionSlot(services, leagueId, agentId, this.log))
      ) {
        this.log.info('chat follow-up skipped: daily limit', { followUp: next.kind });
        continue;
      }
      await dispatchTask(services, task, next.delayMs === undefined ? {} : { delayMs: next.delayMs });
    }
  }

  /** A failure: retried when it may pass (or when this attempt acted), otherwise recorded as `failed`. */
  async failed(stage: string, error: unknown, result: Result): Promise<AgentTaskRecord> {
    if (this.fenced) return this.discard(result);
    if (failureClass(error) === 'retryable' || this.actionsTaken > 0) {
      return this.retryLater(stage, error, result.usage);
    }
    this.log.error('agent task failed', { stage, error: errorName(error) });
    return this.finish(result);
  }

  failedResult(stage: string, error: unknown, reason: string | null, usage: AgentModelUsage[]): Result {
    return {
      status: 'failed',
      fallbackReason: reason,
      toolsCalled: this.calls(),
      finalAction: 'none',
      reasoningSummary: `${stage === 'apply' ? 'Could not apply the decision' : 'Fallback failed'} (${errorName(error)}).`,
      usage
    };
  }

  /**
   * Gives the task back for a later delivery (the recovery sweep sends it at `retryAt`). What the
   * model already spent is counted now; the record is written by the attempt that finishes.
   */
  async retryLater(stage: string, error: unknown, usage: AgentModelUsage[]): Promise<AgentTaskRecord> {
    const fence = this.fence as AgentTaskFence;
    const retryAt = new Date(this.services.clock.now().getTime() + taskRetryDelayMs(fence.attempt));
    const released = await this.services.repos.agents.releaseTask(fence, retryAt, errorName(error));
    await this.charge(usage, false);
    this.log.warn('agent task will be retried', {
      stage,
      attempt: fence.attempt,
      retryAt: retryAt.toISOString(),
      released,
      error: errorName(error)
    });
    return this.report({ ...skipped('retry_scheduled'), toolsCalled: this.calls(), usage });
  }

  /** A newer attempt holds the task: this one writes nothing but the usage it spent. */
  async discard(result: Result): Promise<AgentTaskRecord> {
    await this.charge(result.usage, false);
    this.log.warn('agent task result discarded: a newer attempt holds the task', {
      attempt: this.fence?.attempt ?? null
    });
    return this.report(result);
  }

  /** Records the finished task (fenced to this attempt) and its usage. */
  async finish(result: Result): Promise<AgentTaskRecord> {
    const record = this.record(result);
    const fence = this.fence as AgentTaskFence;
    const stored = await this.services.repos.agents.completeTask(
      record,
      new Date(Date.parse(record.finishedAt) + TASK_RECORD_TTL_MS),
      fence
    );
    if (!stored) return this.discard(result);
    // After the record: a failure here fails the delivery, and the next one (a replay) repairs it.
    await this.charge(result.usage, true);
    this.log.info('agent task finished', {
      taskId: record.taskId,
      leagueId: record.leagueId,
      teamId: record.teamId,
      kind: record.kind,
      trigger: record.trigger.detailType,
      status: record.status,
      fallbackReason: record.fallbackReason,
      finalAction: record.finalAction,
      tools: record.toolsCalled.map((c) => c.name),
      latencyMs: record.latencyMs,
      costUsd: record.costUsd,
      ...(record.attempts === undefined ? {} : { attempts: record.attempts })
    });
    return record;
  }

  /** The record, not stored: a skip, a pending retry, or a discarded run. */
  report(result: Result): AgentTaskRecord {
    const record = this.record(result);
    this.log.info('agent task not recorded', {
      status: record.status,
      fallbackReason: record.fallbackReason,
      costUsd: record.costUsd
    });
    return record;
  }

  /**
   * Holds model call `call`'s estimate against the week's ceiling before it runs (#209). Null when
   * admitted; otherwise the fallback reason: `budget_exceeded` when recorded spend alone leaves no
   * room for it, `budget_reserved` when calls in flight hold the rest (or the admission stayed
   * contended).
   */
  async reserve(
    modelKey: ModelKey,
    call: number,
    estimate: { inputTokens: number; outputTokens: number },
    ceilingUsd: number
  ): Promise<string | null> {
    const { request } = this;
    const fence = this.fence as AgentTaskFence;
    const hold: BudgetHold = {
      leagueId: request.leagueId,
      week: this.week,
      agentId: request.agentId,
      taskId: request.taskId,
      key: usageKey(fence.attempt, call),
      modelKey,
      ...estimate,
      costUsd: estimateCostUsd(modelKey, estimate),
      // The attempt's lease: past it the worker is gone, and the recovery sweep settles the hold.
      expiresAt: new Date(this.started.getTime() + TASK_LOCK_MS).toISOString()
    };
    const admission = await this.services.repos.agents.reserveBudget(hold, ceilingUsd);
    if (admission.status === 'reserved') {
      this.#holds.set(hold.key, hold);
      return null;
    }
    const reason =
      admission.status === 'refused' && roundUsd(admission.spentUsd + hold.costUsd) > ceilingUsd
        ? 'budget_exceeded'
        : 'budget_reserved';
    this.log.warn('agent model call not admitted: no room left in the weekly budget', {
      model: modelKey,
      reason,
      holdUsd: hold.costUsd,
      ceilingUsd,
      ...(admission.status === 'refused'
        ? { spentUsd: admission.spentUsd, reservedUsd: admission.reservedUsd }
        : { contended: true })
    });
    return reason;
  }

  /** Model call `call` spent `spent`: charged now, replacing its hold (retried later if this fails). */
  async settleCall(modelKey: ModelKey, call: number, spent: ModelUsage): Promise<AgentModelUsage> {
    const line: AgentModelUsage = {
      modelKey,
      inputTokens: spent.inputTokens,
      outputTokens: spent.outputTokens,
      estimatedCostUsd: estimateCostUsd(modelKey, spent),
      estimatedTokens: spent.estimated,
      attempt: (this.fence as AgentTaskFence).attempt,
      call
    };
    try {
      await this.charge([line], false);
    } catch (error) {
      this.log.warn('agent usage write failed; retried when the attempt ends', { error: errorName(error) });
    }
    return line;
  }

  /** Model call `call` never ran (the model was unavailable): its hold is let go, nothing charged. */
  async release(call: number): Promise<void> {
    const key = usageKey((this.fence as AgentTaskFence).attempt, call);
    const hold = this.#holds.get(key) as BudgetHold;
    try {
      await this.services.repos.agents.releaseBudget(hold);
      this.#holds.delete(key);
    } catch (error) {
      // Its estimate stays held until the recovery sweep settles it.
      this.log.warn('agent budget hold not released', { error: errorName(error) });
    }
  }

  /**
   * Charges usage lines to the ledger, each once (a line charged before is skipped here, and
   * refused by the ledger if it comes again), releasing their holds; `finished` counts the task in
   * the rollups too, under its own keys. Lines from before the ledger (no attempt) are left alone.
   */
  async charge(usage: readonly AgentModelUsage[], finished: boolean): Promise<void> {
    const { agents } = this.services.repos;
    for (const line of usage) {
      if (line.attempt === undefined || line.call === undefined) continue;
      const key = usageKey(line.attempt, line.call);
      if (this.#charged.has(key)) continue;
      await agents.recordUsage(this.#entry(line, key, 0), this.#holds.get(key));
      this.#charged.add(key);
      this.#holds.delete(key);
    }
    if (!finished) return;
    for (const [index, line] of usage.entries()) {
      if (line.attempt !== undefined) await agents.recordUsage(this.#entry(line, taskCountKey(index), 1));
    }
  }

  /** A ledger line: the usage itself, or (`tasks`) the finished task's count with no tokens. */
  #entry(line: AgentModelUsage, key: string, tasks: number): AgentUsageEntry {
    const { request } = this;
    return {
      leagueId: request.leagueId,
      week: this.week,
      agentId: request.agentId,
      taskId: request.taskId,
      key,
      modelKey: line.modelKey,
      inputTokens: tasks > 0 ? 0 : line.inputTokens,
      outputTokens: tasks > 0 ? 0 : line.outputTokens,
      costUsd: tasks > 0 ? 0 : line.estimatedCostUsd,
      tasks,
      estimated: line.estimatedTokens,
      at: this.services.clock.now().toISOString()
    };
  }

  record(result: Result): AgentTaskRecord {
    const { request, started } = this;
    const finished = this.services.clock.now();
    return {
      taskId: request.taskId,
      leagueId: request.leagueId,
      teamId: request.teamId,
      agentId: request.agentId,
      kind: request.kind,
      week: this.week,
      trigger: { detailType: request.trigger.detailType, eventId: request.trigger.eventId },
      startedAt: started.toISOString(),
      ...result,
      latencyMs: Math.max(0, finished.getTime() - started.getTime()),
      costUsd:
        Math.round(result.usage.reduce((sum, u) => sum + u.estimatedCostUsd, 0) * 1_000_000) / 1_000_000,
      finishedAt: finished.toISOString(),
      ...(this.fence !== null && this.fence.attempt > 1 ? { attempts: this.fence.attempt } : {})
    };
  }
}

/**
 * Takes one of the agent's daily chat-action uses (#196): at most `SOCIAL_LIMITS.chatActionsPerDay`
 * in any 24 hours, claimed atomically (`claimLimit`: a conditional write, so two replies running at
 * once cannot both take the last one). False when they are used up, or the claim stayed contended.
 */
export async function takeChatActionSlot(
  services: Services,
  leagueId: string,
  agentId: string,
  log: Services['log'] = services.log
): Promise<boolean> {
  const result = await services.repos.agents.claimLimit({
    leagueId,
    key: `${agentId}#chat-action`,
    now: services.clock.now(),
    windowMs: SOCIAL_LIMITS.windowMs,
    cap: SOCIAL_LIMITS.chatActionsPerDay
  });
  if (result === 'contended') log.warn('chat-action limit contended; treated as used up', { agentId });
  return result === 'claimed';
}
