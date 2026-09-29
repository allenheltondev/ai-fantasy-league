import {
  estimateTokens,
  ModelUnavailableError,
  type ModelClient,
  type ModelRunRequest,
  type ModelRunResult
} from './model.js';

/**
 * The fake scripted model (`FANTASY_FAKE_MODEL=1`). No Bedrock calls: it replays a script of tool
 * calls through the request's bound tools (so each one still runs through `invokeTool` and the
 * registry), then returns the script's decision, validated against the task's output schema.
 *
 * The script comes from, in order: the `script` option (tests), the request's `fakeScript` hint
 * (each task kind ships a sensible default for local dev), or "do nothing".
 */
export interface FakeStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeScript {
  steps: readonly FakeStep[];
  decision: unknown;
}

export interface ScriptedRequestExtras {
  /** A task kind's default script, used when no override is configured. */
  fakeScript?: () => FakeScript;
}

export interface ScriptedModelOptions {
  /** Override the script per request (tests). Return undefined to fall through to the default. */
  script?: (request: ModelRunRequest<unknown> & ScriptedRequestExtras) => FakeScript | undefined;
  /** Simulate a model failure for a model id (tests of fallbacks and model chains). */
  fail?: (modelId: string) => Error | undefined;
}

export interface FakeTranscriptEntry {
  modelId: string;
  systemPrompt: string;
  input: string;
  toolNames: string[];
  /** The reasoning-depth levers the runner passed. */
  maxIterations: number;
  maxTokens: number;
  thinkingBudgetTokens?: number;
  thinkingEffort?: 'medium' | 'high';
  results: unknown[];
}

export class ScriptedModelClient implements ModelClient {
  readonly name = 'fake';
  /** Every run, for assertions. */
  readonly transcript: FakeTranscriptEntry[] = [];

  constructor(private readonly options: ScriptedModelOptions = {}) {}

  async run<T>(request: ModelRunRequest<T> & ScriptedRequestExtras): Promise<ModelRunResult<T>> {
    const failure = this.options.fail?.(request.modelId);
    if (failure !== undefined) throw failure;
    const script = this.options.script?.(request as ModelRunRequest<unknown> & ScriptedRequestExtras) ??
      request.fakeScript?.() ?? { steps: [], decision: { summary: 'No action (fake model).' } };
    const entry: FakeTranscriptEntry = {
      modelId: request.modelId,
      systemPrompt: request.systemPrompt,
      input: request.input,
      toolNames: request.tools.map((t) => t.name),
      maxIterations: request.maxIterations,
      maxTokens: request.maxTokens,
      ...(request.thinkingBudgetTokens === undefined
        ? {}
        : { thinkingBudgetTokens: request.thinkingBudgetTokens }),
      ...(request.thinkingEffort === undefined ? {} : { thinkingEffort: request.thinkingEffort }),
      results: []
    };
    this.transcript.push(entry);
    let output = '';
    for (const [i, step] of script.steps.entries()) {
      if (request.signal.aborted)
        throw new ModelUnavailableError('The run was aborted.', { cause: request.signal.reason });
      if (i >= request.maxIterations) break;
      const tool = request.tools.find((t) => t.name === step.tool);
      const result =
        tool === undefined
          ? { error: { code: 'NOT_FOUND', message: `Unknown tool ${step.tool}`, fix: 'Use a listed tool.' } }
          : await tool.call(step.args);
      entry.results.push(result);
      output += JSON.stringify(result);
    }
    const decision = request.outputSchema.parse(script.decision);
    return {
      decision,
      stopReason: 'endTurn',
      usage: {
        inputTokens: estimateTokens(request.systemPrompt + request.input + output),
        outputTokens: estimateTokens(JSON.stringify(script)),
        estimated: true
      }
    };
  }
}
