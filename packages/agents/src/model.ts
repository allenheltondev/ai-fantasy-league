import type { z } from 'zod';
import type { BoundTool } from './tools.js';

/**
 * The seam between the runtime and a model. Production uses `StrandsModelClient`
 * (`@readysetcloud/agent` `runAgent` on Bedrock); tests and local dev use `ScriptedModelClient`
 * (`FANTASY_FAKE_MODEL=1`), which replays canned tool calls through the same bound tools, so every
 * call still goes through `invokeTool` and the registry.
 */
export interface ModelRunRequest<T> {
  /** Bedrock model id (inference profile id or model id). */
  modelId: string;
  systemPrompt: string;
  /** The task input: what happened and what to decide. */
  input: string;
  tools: readonly BoundTool[];
  /** Upper bound on model/tool loop iterations. */
  maxIterations: number;
  /** Response token limit, including any thinking budget. */
  maxTokens: number;
  /**
   * Extended-thinking budget (tokens), set only for catalog models that take one
   * (`thinkingBudget`) at medium or high reasoning effort.
   */
  thinkingBudgetTokens?: number;
  temperature: number;
  /** The structured decision the run must end with. */
  outputSchema: z.ZodType<T>;
  /** Aborts the run (the task timeout). */
  signal: AbortSignal;
  /** Trusted, per-run context passed to tools (never shown to the model). */
  invocationState: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when counts are estimated from text length rather than reported by the model. */
  estimated: boolean;
}

export interface ModelRunResult<T> {
  decision: T;
  stopReason: string;
  usage: ModelUsage;
}

export interface ModelClient {
  readonly name: string;
  run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>>;
}

/** Thrown for failures where trying the next model in the tier makes sense (access, throttling). */
export class ModelUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelUnavailableError';
  }
}

/** Rough token estimate from text (about 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const UNAVAILABLE = [
  'AccessDeniedException',
  'ResourceNotFoundException',
  'ValidationException',
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ModelTimeoutException'
];

/** Whether a Bedrock error means "try the next model" rather than "this task failed". */
export function isModelUnavailable(error: unknown): boolean {
  if (error instanceof ModelUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  return (
    UNAVAILABLE.includes(error.name) || /model identifier is invalid|don't have access/i.test(error.message)
  );
}
