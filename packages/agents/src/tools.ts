import type { ResearchAccess, ResearchKind } from '@fantasy/core';
import {
  ApiError,
  invokeTool,
  type AgentPrincipal,
  type AgentToolCall,
  type AnyInputSchema,
  type AnyOperation,
  type Envelope,
  type Registry,
  type Services
} from '@fantasy/server';

/**
 * Tool binding: an agent's tool set is built from the server registry, never hand-written. Every
 * call goes through `invokeTool` with the agent's own principal, so a tool call gets exactly the
 * authorization, validation, phase checks, idempotency, and audit a human's HTTP request gets.
 * On top of that the binding narrows what an agent can reach:
 *
 * - operations humans alone may call (`auth: 'user'`) are never bound;
 * - research tools are bound only when the difficulty's research access allows them;
 * - a task kind can restrict the set further with an allowlist;
 * - mutations that name a `teamId` must name the agent's own team;
 * - mutations stop after the difficulty's action budget for the trigger;
 * - the idempotency key is derived from the task (trigger event) and the step number, never
 *   chosen by the model, so a redelivered trigger replays instead of acting twice;
 * - the free-text note on a trade offer (`message` on trade views) is withheld: it is written by
 *   another manager, reaches the agent only through tools, and would otherwise be a prompt
 *   injection path into a task that can accept trades (issue #122);
 * - every mutation first passes the runner's fence (`beforeMutation`, #207): the attempt must still
 *   hold the task, so a worker whose lease was taken over cannot act any more (`fenced`).
 */

/** Research tools by name (SPEC §6). Operations can also opt in with a `research:<kind>` tag. */
export const RESEARCH_TOOLS: Readonly<Record<string, ResearchKind>> = {
  get_projections: 'projections',
  get_news: 'news',
  get_trending_players: 'trending',
  get_matchup_outlook: 'matchupOutlook'
};

/** The research kind an operation needs, or null when it is not a research tool. */
export function researchKindOf(op: AnyOperation): ResearchKind | null {
  const tag = op.tags?.find((t) => t.startsWith('research:'));
  if (tag !== undefined) return tag.slice('research:'.length) as ResearchKind;
  return RESEARCH_TOOLS[op.name] ?? null;
}

export interface BoundTool {
  name: string;
  description: string;
  mutation: boolean;
  /** What the model supplies: the operation's input schema (no idempotency key). */
  inputSchema: AnyInputSchema;
  call(args: Record<string, unknown>): Promise<Envelope>;
}

export interface ToolBoxOptions {
  registry: Registry;
  services: Services;
  /** Created by the runtime in-process; never taken from the model or a request. */
  principal: AgentPrincipal;
  research: ResearchAccess;
  /** Task-kind allowlist; undefined means every tool the agent may use. */
  allow?: readonly string[];
  actionsPerTrigger: number;
  /** Unique per trigger (the task id); the idempotency key is `<prefix>:<step>`. */
  idempotencyPrefix: string;
  /**
   * Called before each mutation reaches its operation (the runner records the effect under its
   * fence). False refuses the mutation and every later one: the task was taken over.
   */
  beforeMutation?: () => Promise<boolean>;
}

/** Operations an agent may ever be given, before research and task filters. */
export function agentEligible(op: AnyOperation): boolean {
  return op.auth !== 'user';
}

function errorEnvelope(error: ApiError): Envelope {
  return { error: error.toBody() };
}

export class ToolBox {
  readonly tools: readonly BoundTool[];
  readonly calls: AgentToolCall[] = [];
  #mutations = 0;
  #step = 0;
  #fenced = false;
  readonly #options: ToolBoxOptions;
  readonly #byName: ReadonlyMap<string, AnyOperation>;

  constructor(options: ToolBoxOptions) {
    this.#options = options;
    const ops = options.registry.operations.filter((op) => {
      if (!agentEligible(op)) return false;
      if (options.allow !== undefined && !options.allow.includes(op.name)) return false;
      const kind = researchKindOf(op);
      return kind === null || options.research[kind] === true;
    });
    this.#byName = new Map(ops.map((op) => [op.name, op]));
    this.tools = ops.map((op) => ({
      name: op.name,
      description: `${op.summary}.\n\n${op.description}`,
      mutation: op.mutation,
      inputSchema: op.input,
      call: (args: Record<string, unknown>) => this.call(op.name, args)
    }));
  }

  /** Mutating calls that reached the operation (successful or not). */
  get actionsTaken(): number {
    return this.#mutations;
  }

  /** True once a mutation was refused because a newer attempt holds the task. */
  get fenced(): boolean {
    return this.#fenced;
  }

  /**
   * Calls a tool by name with model-supplied arguments. Returns the response envelope. Deterministic
   * code may name a mutation's key (`key`, under this task's prefix) for a step that a retry may
   * reach in a different order. Delivery recovery may additionally choose `global`: its key is
   * derived from persisted state, never model input, and must replay across different task ids.
   */
  async call(
    name: string,
    rawArgs: Record<string, unknown>,
    options: { key?: string; global?: boolean } = {}
  ): Promise<Envelope> {
    const { principal } = this.#options;
    const op = this.#byName.get(name);
    if (op === undefined) {
      return this.#reject(name, false, 'FORBIDDEN', `The tool "${name}" is not available to you.`, {
        fix: 'Use only the tools you were given for this task.'
      });
    }
    const { idempotencyKey: _ignored, ...args } = rawArgs;
    if ('leagueId' in op.input.shape && args.leagueId === undefined) args.leagueId = principal.leagueId;
    if (op.mutation) {
      if ('teamId' in op.input.shape && args.teamId !== undefined && args.teamId !== principal.teamId) {
        return this.#reject(name, true, 'FORBIDDEN', 'You can only act for your own team.', {
          fix: `Use teamId "${principal.teamId}".`
        });
      }
      if (this.#mutations >= this.#options.actionsPerTrigger) {
        return this.#reject(name, true, 'FORBIDDEN', 'You have used every action allowed for this task.', {
          fix: 'Stop taking actions and give your final answer.',
          details: { actionsPerTrigger: this.#options.actionsPerTrigger }
        });
      }
      if (
        this.#fenced ||
        (this.#options.beforeMutation !== undefined && !(await this.#options.beforeMutation()))
      ) {
        this.#fenced = true;
        return this.#reject(name, true, 'CONFLICT', 'This task was taken over by a newer attempt.', {
          fix: 'Stop taking actions and give your final answer; the newer attempt finishes the task.'
        });
      }
      this.#mutations += 1;
    }
    const key = op.mutation
      ? options.global === true && options.key !== undefined
        ? options.key
        : `${this.#options.idempotencyPrefix}:${options.key ?? ++this.#step}`
      : undefined;
    const result = await invokeTool({
      registry: this.#options.registry,
      services: this.#options.services,
      principal,
      name,
      args: key === undefined ? args : { ...args, idempotencyKey: key }
    });
    const body = withholdTradeNotes(result.body);
    this.calls.push({
      name,
      mutation: op.mutation,
      ok: !('error' in body),
      errorCode: 'error' in body ? body.error.code : null
    });
    return body;
  }

  #reject(
    name: string,
    mutation: boolean,
    code: 'FORBIDDEN' | 'CONFLICT',
    message: string,
    options: { fix: string; details?: Record<string, unknown> }
  ): Envelope {
    this.calls.push({ name, mutation, ok: false, errorCode: code });
    return errorEnvelope(new ApiError(code, message, options));
  }
}

/** Trade views in a tool result (`trade`, `countered`, `trades[]`), with their notes withheld. */
export function withholdTradeNotes(body: Envelope): Envelope {
  if ('error' in body || body.data === null || typeof body.data !== 'object') return body;
  const data = { ...(body.data as Record<string, unknown>) };
  let changed = false;
  const strip = (view: unknown): unknown => {
    if (view === null || typeof view !== 'object' || !('message' in view)) return view;
    changed = true;
    return { ...view, message: null };
  };
  for (const key of ['trade', 'countered']) if (key in data) data[key] = strip(data[key]);
  if (Array.isArray(data.trades)) data.trades = data.trades.map(strip);
  return changed ? { ...body, data } : body;
}

/** Idempotency-key-safe form of a task id (keys allow A-Z a-z 0-9 _ . : -). */
export function keyPrefix(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return safe.length > 100 ? safe.slice(0, 100) : safe.padEnd(8, '_');
}
