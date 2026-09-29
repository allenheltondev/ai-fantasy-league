import type { Clock, MemoryEvent, ResolvedAgentConfig } from '@fantasy/core';
import type { AgentPrincipal, AgentSeatRecord, AgentTaskSeal, League, Logger } from '@fantasy/server';
import { z } from 'zod';
import type { FakeScript } from '../fake-model.js';
import type { ChatMemoryScope } from '../memory.js';
import { MEMORY_NOTE_MAX } from '../prompt.js';
import type { ToolBox } from '../tools.js';

/**
 * Task kinds: the extension point feature streams (draft, lineups, waivers, trades, chat) implement.
 *
 * A task kind turns one `Agent Action Requested` event into a decision. The runtime owns
 * everything around it (idempotent claim, kill switch, budget, model choice and fallbacks, tool
 * binding, observability); a kind supplies only the football:
 *
 * 1. `prepare` gathers what the decision needs with deterministic tool calls (`ctx.tools`) and
 *    deterministic core code (optimizer, valuations, autopick).
 * 2. `instructions` describes the task for the model; the runtime adds persona, strategy, rules,
 *    and memory around it. The model can call the kind's allowed tools (`tools`), filtered by the
 *    agent's research access and action budget, and must finish with a `decision` object.
 * 3. `apply` carries out the model's decision (often through `ctx.tools`).
 * 4. `fallback` is the deterministic behavior used when there is no model decision: the kill switch
 *    is on, the league is over budget, every model is unavailable, the run timed out, or the model
 *    failed. It must be safe and cheap: autopick for the draft, the optimizer for lineups, no claims
 *    for waivers, reject for trades.
 * 5. `fakeScript` (optional) is the canned model behavior used with `FANTASY_FAKE_MODEL=1`.
 *
 * Register a kind by adding it to `DEFAULT_TASK_KINDS` (or pass your own registry to the runner),
 * and map the events that should trigger it in `router.ts`.
 */

/** Every decision includes a short summary and may leave a note for the agent's memory. */
export const BaseDecisionSchema = z.object({
  summary: z.string().min(1).max(600).describe('One or two sentences: what you decided and why.'),
  memoryNote: z
    .string()
    .max(MEMORY_NOTE_MAX)
    .optional()
    .describe('Optional fact worth remembering next time (a rivalry, a grudge, a player you like).')
});
export type BaseDecision = z.infer<typeof BaseDecisionSchema>;

export interface TaskContext {
  taskId: string;
  principal: AgentPrincipal;
  league: League;
  seat: AgentSeatRecord;
  config: ResolvedAgentConfig;
  /**
   * Deterministic tool access for prepare/apply/fallback. Same pipeline and same own-team checks
   * as the model's tools, with full research access (deterministic code is not the model).
   */
  tools: ToolBox;
  clock: Clock;
  log: Logger;
  trigger: { detailType: string; eventId: string };
}

export interface TaskOutcome {
  /** A short machine-friendly label of the final action, e.g. `set_lineup`, `none`. */
  action: string;
  /** What happened, for the activity log. */
  summary: string;
  /** Extra events for the agent's memory (the runner already remembers the decision itself). */
  memory?: MemoryEvent[];
  /**
   * The decision as the agent's memory keeps it, when `summary` should not be kept: a kind whose
   * model reads other people's text (a trade note, say) remembers a deterministic line instead of
   * model-written words.
   */
  memorySummary?: string;
  /**
   * Set when `summary` holds sealed information (waiver bids, private trade terms, a veto vote):
   * the commissioner's activity log shows `sealed.summary` until those moves resolve.
   */
  sealed?: AgentTaskSeal;
  /**
   * More tasks for the same agent and trigger, requested once this one is recorded (the post-draft
   * kickoff hands its early trade look to `trade_proposal`). Each runs as its own task, through
   * the same claim, kill switch, and budget; its task id comes from the trigger and its kind, so a
   * replay never doubles it.
   */
  followUps?: TaskFollowUp[];
}

export interface TaskFollowUp {
  kind: string;
  payload: Record<string, unknown>;
  /** Wait this long before it runs (scheduled); right away when left out. */
  delayMs?: number;
  /**
   * A conversation handed to an action task (#196): the runner holds these to
   * `SOCIAL_LIMITS.chatActionsPerDay` per agent.
   */
  chatDriven?: boolean;
}

export interface TaskKindSpec<P, D extends BaseDecision, Prep> {
  kind: string;
  title: string;
  /** `decision` models for draft/trades/waivers/lineups; the cheaper `chat` models for chat. */
  modelRole: 'decision' | 'chat';
  payload: z.ZodType<P>;
  decision: z.ZodType<D>;
  /** Tools the model may call for this kind; undefined means every tool the agent may use. */
  tools?: readonly string[];
  /** Narrows `tools` for one run, from what `prepare` found (the kickoff binds rename_team only to name a team). */
  toolsFor?(ctx: TaskContext, payload: P, prep: Prep): readonly string[];
  /**
   * Mutations the model may make in one run, instead of the difficulty's `actionsPerTrigger`: the
   * naming kinds allow one rename and one retry, whatever the tier.
   */
  modelActions?: number;
  /**
   * False for kinds whose model reads text other people wrote (trade kinds): the model's
   * `memoryNote` is not persisted, so nothing it was talked into survives into later prompts.
   */
  modelNotes?: boolean;
  prepare(ctx: TaskContext, payload: P): Promise<Prep>;
  instructions(ctx: TaskContext, payload: P, prep: Prep): string;
  apply(ctx: TaskContext, payload: P, prep: Prep, decision: D): Promise<TaskOutcome>;
  fallback(ctx: TaskContext, payload: P, prep: Prep): Promise<TaskOutcome>;
  fakeScript?(ctx: TaskContext, payload: P, prep: Prep): FakeScript;
  /** Chat kinds: the room and teams whose chat memory the prompt may show (`memoryForPrompt`). */
  memoryScope?(ctx: TaskContext, payload: P, prep: Prep): ChatMemoryScope;
}

/** A kind with its types closed over, as the runtime sees it. */
export interface PreparedTask {
  instructions: string;
  decision: z.ZodType<BaseDecision>;
  apply(decision: unknown): Promise<TaskOutcome>;
  fallback(): Promise<TaskOutcome>;
  fakeScript?: () => FakeScript;
  memoryScope?: ChatMemoryScope;
  /** The model's tools for this run, when the kind narrows them (`toolsFor`). */
  tools?: readonly string[];
}

export interface TaskKind {
  kind: string;
  title: string;
  modelRole: 'decision' | 'chat';
  tools?: readonly string[];
  modelActions?: number;
  modelNotes?: boolean;
  prepare(ctx: TaskContext, payload: unknown): Promise<PreparedTask>;
}

export function defineTaskKind<P, D extends BaseDecision, Prep>(spec: TaskKindSpec<P, D, Prep>): TaskKind {
  return {
    kind: spec.kind,
    title: spec.title,
    modelRole: spec.modelRole,
    ...(spec.tools === undefined ? {} : { tools: spec.tools }),
    ...(spec.modelActions === undefined ? {} : { modelActions: spec.modelActions }),
    ...(spec.modelNotes === undefined ? {} : { modelNotes: spec.modelNotes }),
    async prepare(ctx, rawPayload) {
      const payload = spec.payload.parse(rawPayload);
      const prep = await spec.prepare(ctx, payload);
      const fakeScript = spec.fakeScript;
      const memoryScope = spec.memoryScope?.(ctx, payload, prep);
      const tools = spec.toolsFor?.(ctx, payload, prep);
      return {
        instructions: spec.instructions(ctx, payload, prep),
        decision: spec.decision,
        apply: (decision) => spec.apply(ctx, payload, prep, spec.decision.parse(decision)),
        fallback: () => spec.fallback(ctx, payload, prep),
        ...(fakeScript === undefined ? {} : { fakeScript: () => fakeScript(ctx, payload, prep) }),
        ...(memoryScope === undefined ? {} : { memoryScope }),
        ...(tools === undefined ? {} : { tools })
      };
    }
  };
}

export interface TaskKindRegistry {
  get(kind: string): TaskKind | undefined;
  readonly kinds: readonly string[];
}

export function createTaskKindRegistry(kinds: readonly TaskKind[]): TaskKindRegistry {
  const byKind = new Map<string, TaskKind>();
  for (const k of kinds) {
    if (byKind.has(k.kind)) throw new Error(`Duplicate task kind "${k.kind}"`);
    byKind.set(k.kind, k);
  }
  return { get: (kind) => byKind.get(kind), kinds: [...byKind.keys()].sort() };
}
