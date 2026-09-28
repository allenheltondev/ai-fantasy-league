import {
  RESEARCH_KINDS,
  estimateCostUsd,
  getModel,
  resolveAgentConfig,
  type ModelKey,
  type ReasoningEffort,
  type ResearchAccess
} from '@fantasy/core';
import {
  agentPrincipal,
  budgetWeek,
  leagueBudget,
  type AgentModelUsage,
  type AgentTaskRecord,
  type League,
  type Registry,
  type Services
} from '@fantasy/server';
import type { AgentActionRequested } from './events.js';
import type { ScriptedRequestExtras } from './fake-model.js';
import type { KillSwitch } from './kill-switch.js';
import { isModelUnavailable, type ModelClient } from './model.js';
import { MEMORY_NOTE_MAX, MEMORY_NOTES_KEPT, assembleSystemPrompt } from './prompt.js';
import type {
  BaseDecision,
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
 * 1. Claim the task id (idempotent per trigger event: a redelivery returns the stored record).
 * 2. Load the league and seat, resolve the config, and let the task kind prepare.
 * 3. Decide the mode: deterministic fallback if the kill switch is on or the league's weekly budget
 *    is spent; otherwise the model, trying each model in the tier's chain.
 * 4. On a model timeout or failure, fall back to the kind's deterministic behavior.
 * 5. Record everything (#45): trigger, tools called, final action, reasoning summary, latency,
 *    tokens and estimated cost per model; add the weekly rollups; keep the agent's memory note.
 */

export interface RunnerDeps {
  registry: Registry;
  services: Services;
  kinds: TaskKindRegistry;
  model: ModelClient;
  killSwitch: KillSwitch;
  /** Wall-clock budget for the model part of a task. */
  modelTimeoutMs?: number;
}

/** How long a crashed run blocks a retry of the same task. */
export const TASK_LOCK_MS = 5 * 60 * 1000;
/** How long task records are kept. */
export const TASK_RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Mutations deterministic code may make in one task. */
export const DETERMINISTIC_ACTIONS = 10;

const MAX_TOKENS: Record<ReasoningEffort, number> = { low: 1024, medium: 2048, high: 4096 };

const FULL_RESEARCH = Object.fromEntries(RESEARCH_KINDS.map((k) => [k, true])) as ResearchAccess;

export async function runAgentAction(
  deps: RunnerDeps,
  request: AgentActionRequested
): Promise<AgentTaskRecord> {
  const { services } = deps;
  const clock = services.clock;
  const log = services.log.child({ taskId: request.taskId, kind: request.kind, teamId: request.teamId });
  const started = clock.now();
  const base = {
    taskId: request.taskId,
    leagueId: request.leagueId,
    teamId: request.teamId,
    agentId: request.agentId,
    kind: request.kind,
    trigger: { detailType: request.trigger.detailType, eventId: request.trigger.eventId },
    startedAt: started.toISOString()
  };

  const claim = await services.repos.agents.claimTask({
    taskId: request.taskId,
    now: started,
    lockUntil: new Date(started.getTime() + TASK_LOCK_MS)
  });
  if (claim.status === 'done') {
    log.info('agent task already done; replaying', { status: claim.record.status });
    return claim.record;
  }
  if (claim.status === 'in_progress') {
    log.info('agent task already running elsewhere');
    return finish(deps, { ...base, week: 0 }, started, skipped('in_progress'), false);
  }

  const league = await services.repos.leagues.get(request.leagueId);
  const seat = league === null ? null : await services.repos.agents.getSeat(request.leagueId, request.teamId);
  const kind = deps.kinds.get(request.kind);
  const week = league === null ? 0 : budgetWeek(league);
  if (league === null || seat === null || seat.agentId !== request.agentId || kind === undefined) {
    const reason =
      league === null
        ? 'league_not_found'
        : seat === null || seat.agentId !== request.agentId
          ? 'no_agent_seat'
          : 'unknown_kind';
    return finish(deps, { ...base, week }, started, skipped(reason), true);
  }

  const principal = agentPrincipal({ agentId: seat.agentId, teamId: seat.teamId, leagueId: league.id });
  const config = resolveAgentConfig(seat.config);
  const prefix = keyPrefix(request.taskId);
  const system = new ToolBox({
    registry: deps.registry,
    services,
    principal,
    research: FULL_RESEARCH,
    actionsPerTrigger: DETERMINISTIC_ACTIONS,
    idempotencyPrefix: `${prefix}:sys`
  });
  const ctx: TaskContext = {
    taskId: request.taskId,
    principal,
    league,
    seat,
    config,
    tools: system,
    clock,
    log,
    trigger: base.trigger
  };

  let prepared: PreparedTask;
  try {
    prepared = await kind.prepare(ctx, request.payload);
  } catch (error) {
    const reason = error instanceof TaskUnavailableError ? error.message : 'prepare_failed';
    if (!(error instanceof TaskUnavailableError)) log.error('agent task prepare failed', { error });
    return finish(
      deps,
      { ...base, week },
      started,
      { ...skipped(reason), toolsCalled: [...system.calls] },
      true
    );
  }

  const gate = await modeGate(deps, league);
  if (gate !== null) {
    return runFallback(deps, { ...base, week }, started, prepared, system, gate);
  }

  const modelTools = new ToolBox({
    registry: deps.registry,
    services,
    principal,
    research: config.levers.research,
    ...(kind.tools === undefined ? {} : { allow: kind.tools }),
    actionsPerTrigger: config.levers.actionsPerTrigger,
    idempotencyPrefix: prefix
  });
  const memory = await services.repos.agents.getMemory(league.id, seat.agentId);
  const systemPrompt = assembleSystemPrompt({
    config,
    league,
    teamId: seat.teamId,
    memory,
    task: { title: kind.title, instructions: prepared.instructions }
  });
  const chain: ModelKey[] = kind.modelRole === 'chat' ? config.models.chat : config.models.decision;
  const usage: AgentModelUsage[] = [];
  let lastError: unknown = null;
  for (const modelKey of chain) {
    const model = getModel(modelKey);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('agent task timed out')),
      deps.modelTimeoutMs ?? 90_000
    );
    try {
      const runRequest = {
        modelId: model.bedrockId,
        systemPrompt,
        input: `Trigger: ${request.trigger.detailType}. Do the current task, then give your structured answer.`,
        tools: modelTools.tools,
        maxIterations: config.levers.maxToolSteps,
        maxTokens: MAX_TOKENS[config.levers.reasoningEffort],
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
      const result = await deps.model.run<BaseDecision>(runRequest);
      usage.push({
        modelKey,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCostUsd: estimateCostUsd(modelKey, result.usage),
        estimatedTokens: result.usage.estimated
      });
      clearTimeout(timer);
      let outcome: TaskOutcome;
      try {
        outcome = await prepared.apply(result.decision);
      } catch (error) {
        log.error('agent decision could not be applied', { error });
        return finish(
          deps,
          { ...base, week },
          started,
          {
            status: 'failed',
            fallbackReason: null,
            toolsCalled: [...modelTools.calls, ...system.calls],
            finalAction: 'none',
            reasoningSummary: `Could not apply the decision: ${error instanceof Error ? error.message : String(error)}`,
            usage
          },
          true
        );
      }
      if (result.decision.memoryNote !== undefined && result.decision.memoryNote.trim().length > 0) {
        await services.repos.agents.appendMemory(
          league.id,
          seat.agentId,
          result.decision.memoryNote.trim().slice(0, MEMORY_NOTE_MAX),
          MEMORY_NOTES_KEPT
        );
      }
      return finish(
        deps,
        { ...base, week },
        started,
        {
          status: 'completed',
          fallbackReason: null,
          toolsCalled: [...modelTools.calls, ...system.calls],
          finalAction: outcome.action,
          reasoningSummary: outcome.summary,
          usage
        },
        true
      );
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      const timedOut = controller.signal.aborted;
      log.warn('agent model run failed', { model: modelKey, timedOut, error });
      if (!timedOut && isModelUnavailable(error) && modelTools.actionsTaken === 0) continue;
      return runFallback(
        deps,
        { ...base, week },
        started,
        prepared,
        system,
        timedOut ? 'timeout' : 'model_error',
        modelTools,
        usage
      );
    }
  }
  log.warn('every model in the chain was unavailable', { chain, error: lastError });
  return runFallback(
    deps,
    { ...base, week },
    started,
    prepared,
    system,
    'models_unavailable',
    modelTools,
    usage
  );
}

async function modeGate(deps: RunnerDeps, league: League): Promise<string | null> {
  if (await deps.killSwitch.engaged()) return 'kill_switch';
  const budget = await leagueBudget(deps.services.repos.agents, league);
  if (budget.exceeded) {
    deps.services.log.warn('league agent budget exceeded; using deterministic fallbacks', {
      leagueId: league.id,
      week: budget.week,
      spentUsd: budget.spentUsd,
      ceilingUsd: budget.ceilingUsd
    });
    return 'budget_exceeded';
  }
  return null;
}

type Base = Omit<
  AgentTaskRecord,
  | 'status'
  | 'fallbackReason'
  | 'toolsCalled'
  | 'finalAction'
  | 'reasoningSummary'
  | 'latencyMs'
  | 'usage'
  | 'costUsd'
  | 'finishedAt'
>;
type Result = Pick<
  AgentTaskRecord,
  'status' | 'fallbackReason' | 'toolsCalled' | 'finalAction' | 'reasoningSummary' | 'usage'
>;

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

async function runFallback(
  deps: RunnerDeps,
  base: Base,
  started: Date,
  prepared: PreparedTask,
  system: ToolBox,
  reason: string,
  modelTools?: ToolBox,
  usage: AgentModelUsage[] = []
): Promise<AgentTaskRecord> {
  const calls = () => [...(modelTools?.calls ?? []), ...system.calls];
  try {
    const outcome = await prepared.fallback();
    return finish(
      deps,
      base,
      started,
      {
        status: 'fallback',
        fallbackReason: reason,
        toolsCalled: calls(),
        finalAction: outcome.action,
        reasoningSummary: outcome.summary,
        usage
      },
      true
    );
  } catch (error) {
    deps.services.log.error('agent fallback failed', { taskId: base.taskId, error });
    return finish(
      deps,
      base,
      started,
      {
        status: 'failed',
        fallbackReason: reason,
        toolsCalled: calls(),
        finalAction: 'none',
        reasoningSummary: `Fallback failed: ${error instanceof Error ? error.message : String(error)}`,
        usage
      },
      true
    );
  }
}

async function finish(
  deps: RunnerDeps,
  base: Base,
  started: Date,
  result: Result,
  store: boolean
): Promise<AgentTaskRecord> {
  const { services } = deps;
  const finished = services.clock.now();
  const record: AgentTaskRecord = {
    ...base,
    ...result,
    latencyMs: Math.max(0, finished.getTime() - started.getTime()),
    costUsd: Math.round(result.usage.reduce((sum, u) => sum + u.estimatedCostUsd, 0) * 1_000_000) / 1_000_000,
    finishedAt: finished.toISOString()
  };
  if (store) {
    await services.repos.agents.completeTask(record, new Date(finished.getTime() + TASK_RECORD_TTL_MS));
    for (const u of result.usage) {
      await services.repos.agents.addUsage({
        leagueId: record.leagueId,
        week: record.week,
        agentId: record.agentId,
        modelKey: u.modelKey,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costUsd: u.estimatedCostUsd,
        tasks: 1
      });
    }
  }
  services.log.info('agent task finished', {
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
    costUsd: record.costUsd
  });
  return record;
}
