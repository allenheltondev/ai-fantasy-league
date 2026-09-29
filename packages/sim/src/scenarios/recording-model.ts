import { performance } from 'node:perf_hooks';
import type { Clock } from '@fantasy/core';
import type { ModelClient, ModelRunRequest, ModelRunResult, ModelUsage } from '@fantasy/agents';

/** One model run, as the scenarios and the evaluation read it. */
export interface ModelRun {
  taskId: string;
  /** The task kind (a task id starts with it). */
  kind: string;
  teamId: string;
  /** Simulated time of the run. */
  at: string | null;
  modelId: string;
  /** The prompt as the model received it (after any ablation). */
  systemPrompt: string;
  input: string;
  /** Tools the model could call (chat tasks read; decision tasks act). */
  tools: string[];
  decision: unknown;
  usage: ModelUsage | null;
  /** Wall time of the call. */
  latencyMs: number;
  /** Set when the call threw (the runner then tries the next model or falls back). */
  error: string | null;
}

/** Changes a prompt before the model sees it (an ablation): returns the new system prompt. */
export type PromptTransform = (systemPrompt: string) => string;

/**
 * Wraps a model and records every run with the task it served (from the runner's trusted
 * `invocationState`), so a scenario can check what each agent was shown and what it decided, and an
 * evaluation can count latency and usage. `transform` rewrites the system prompt first (ablations).
 */
export class RecordingModel implements ModelClient {
  readonly runs: ModelRun[] = [];
  /** The replay's clock, once the league exists (runs before it record `at: null`). */
  clock: Clock | null = null;

  constructor(
    readonly inner: ModelClient,
    private readonly transform: PromptTransform = (p) => p
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    const state = request.invocationState as { taskId?: string; teamId?: string };
    const taskId = state.taskId ?? 'unknown';
    const systemPrompt = this.transform(request.systemPrompt);
    const run: ModelRun = {
      taskId,
      kind: taskId.split('.')[0] as string,
      teamId: state.teamId ?? 'unknown',
      at: this.clock?.now().toISOString() ?? null,
      modelId: request.modelId,
      systemPrompt,
      input: request.input,
      tools: request.tools.map((t) => t.name),
      decision: null,
      usage: null,
      latencyMs: 0,
      error: null
    };
    this.runs.push(run);
    const started = performance.now();
    try {
      const result = await this.inner.run({ ...request, systemPrompt });
      run.decision = result.decision;
      run.usage = result.usage;
      return result;
    } catch (error) {
      run.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      run.latencyMs = Math.round(performance.now() - started);
    }
  }
}

/** The prompt's `# ` sections (core `assembleSystemPrompt` joins them with a blank line). */
function sections(prompt: string): string[] {
  return prompt.split(/\n\n(?=# )/);
}

/** Drops the sections whose heading starts with any of `headings`. */
export function withoutSections(...headings: string[]): PromptTransform {
  return (prompt) =>
    sections(prompt)
      .filter((s) => !headings.some((h) => s.startsWith(`# ${h}`)))
      .join('\n\n');
}

/** The prompt's memory section, or '' when it has none. */
export function memorySection(prompt: string): string {
  return sections(prompt).find((s) => s.startsWith('# What you remember')) ?? '';
}
