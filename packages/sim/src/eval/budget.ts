import { MODEL_CATALOG, estimateCostUsd } from '@fantasy/core';
import {
  ModelUnavailableError,
  estimateTokens,
  type ModelClient,
  type ModelRunRequest,
  type ModelRunResult
} from '@fantasy/agents';

/**
 * Cost control for the live evaluation (#211): it calls a paid model, so it runs only when asked
 * for in so many words, never in CI, and never past a hard budget.
 */

/** The most one evaluation may be allowed to spend, whatever `--budget-usd` says. */
export const MAX_EVAL_BUDGET_USD = 50;

/** Why a live evaluation may not run, or null when it may. */
export function liveEvalRefusal(
  env: Record<string, string | undefined>,
  budgetUsd: number | undefined
): string | null {
  if (env.FANTASY_LIVE_EVAL !== '1')
    return 'The live evaluation calls a paid model. Set FANTASY_LIVE_EVAL=1 to run it on purpose.';
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false')
    return 'The live evaluation never runs in CI (CI is set). Run it from a workstation.';
  if (budgetUsd === undefined || !Number.isFinite(budgetUsd) || budgetUsd <= 0)
    return 'Give a hard budget in dollars with --budget-usd (for example --budget-usd 5).';
  if (budgetUsd > MAX_EVAL_BUDGET_USD)
    return `--budget-usd ${budgetUsd} is over the ${MAX_EVAL_BUDGET_USD} dollar ceiling for one evaluation.`;
  return null;
}

/** Thrown in place of a call the budget cannot cover: the runner falls back, and the run is marked. */
export class BudgetExhaustedError extends ModelUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * A hard spend cap around a model. Before each call it reserves the call's worst case (the prompt
 * read on every tool-loop turn, up to four, plus the full response limit, at the catalog price);
 * a call that would take spend past the cap is refused (`BudgetExhaustedError`, so the agent's
 * deterministic fallback decides instead). After the call the reservation is replaced by the
 * usage the model reported. Spend therefore stays under the cap unless a model reports more usage
 * than the worst case (for example more than four tool-loop turns).
 */
export class BudgetedModel implements ModelClient {
  spentUsd = 0;
  refused = 0;
  #reserved = 0;

  constructor(
    readonly inner: ModelClient,
    readonly capUsd: number
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get exhausted(): boolean {
    return this.refused > 0;
  }

  /** The worst case of one call, in dollars. */
  static reserve(
    request: Pick<
      ModelRunRequest<unknown>,
      'modelId' | 'systemPrompt' | 'input' | 'maxIterations' | 'maxTokens'
    >
  ): number {
    const prompt = estimateTokens(request.systemPrompt + request.input);
    return estimateCostUsd(request.modelId, {
      inputTokens: prompt * Math.min(Math.max(request.maxIterations, 1), 4),
      outputTokens: request.maxTokens
    });
  }

  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    const reserve = BudgetedModel.reserve(request);
    if (this.spentUsd + this.#reserved + reserve > this.capUsd) {
      this.refused++;
      throw new BudgetExhaustedError(
        `The evaluation budget ($${this.capUsd}) cannot cover this call ($${this.spentUsd.toFixed(4)} spent).`
      );
    }
    this.#reserved += reserve;
    try {
      const result = await this.inner.run(request);
      this.spentUsd += estimateCostUsd(request.modelId, result.usage);
      return result;
    } finally {
      this.#reserved -= reserve;
    }
  }
}

/**
 * Plays every seat on one catalog model, whatever tier its seat asks for, so conditions compare the
 * same model (the seats' personalities and difficulties are kept).
 */
export class PinnedModel implements ModelClient {
  readonly bedrockId: string;

  constructor(
    readonly inner: ModelClient,
    modelKey: string
  ) {
    const model = MODEL_CATALOG.find((m) => m.key === modelKey);
    if (model === undefined)
      throw new Error(
        `Unknown model ${modelKey}. Use one of: ${MODEL_CATALOG.map((m) => m.key).join(', ')}.`
      );
    this.bedrockId = model.bedrockId;
  }

  get name(): string {
    return this.inner.name;
  }

  run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    return this.inner.run({ ...request, modelId: this.bedrockId });
  }
}
