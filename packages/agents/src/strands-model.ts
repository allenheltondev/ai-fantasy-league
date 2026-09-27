import { runAgent, tool } from '@readysetcloud/agent';
import { MODEL_REGION } from '@fantasy/core';
import { estimateTokens, type ModelClient, type ModelRunRequest, type ModelRunResult } from './model.js';

/**
 * The Bedrock model client, built on `@readysetcloud/agent`'s `runAgent`: a stateless one-shot run
 * with structured output (`outputSchema`), a bounded tool loop (`maxIterations`), trusted context
 * (`invocationState`), and a cancel signal. We use `runAgent` rather than `runAgentTask` because a
 * league task needs none of the rsc-core session/snapshot plumbing: idempotency is our own claim on
 * the task id in the league table, and the result is the structured decision, not chat text.
 *
 * Token usage: `runAgent` does not return the SDK's metrics, so each tool callback snapshots
 * `context.agent.metrics.accumulatedUsage` into invocation state. The final model turn after the
 * last tool call is not in that snapshot, so it is estimated from the context size and the final
 * text, and the usage is flagged `estimated` in that case.
 */

interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  latestContextSize: number;
}

interface UsageCarrier {
  agent?: {
    metrics?: {
      accumulatedUsage?: { inputTokens?: number; outputTokens?: number };
      latestContextSize?: number;
    };
  };
}

function snapshot(context: unknown): UsageSnapshot | null {
  const metrics = (context as UsageCarrier | undefined)?.agent?.metrics;
  if (metrics?.accumulatedUsage === undefined) return null;
  return {
    inputTokens: metrics.accumulatedUsage.inputTokens ?? 0,
    outputTokens: metrics.accumulatedUsage.outputTokens ?? 0,
    latestContextSize: metrics.latestContextSize ?? 0
  };
}

export class StrandsModelClient implements ModelClient {
  readonly name = 'bedrock';

  constructor(private readonly region: string = MODEL_REGION) {}

  async run<T>(request: ModelRunRequest<T>): Promise<ModelRunResult<T>> {
    let last: UsageSnapshot | null = null;
    let lastToolOutput = '';
    const tools = request.tools.map((bound) =>
      tool({
        name: bound.name,
        description: bound.description,
        inputSchema: bound.inputSchema,
        callback: async (input, context) => {
          last = snapshot(context) ?? last;
          const envelope = await bound.call(input as Record<string, unknown>);
          lastToolOutput = JSON.stringify(envelope);
          return lastToolOutput;
        }
      })
    );
    const result = await runAgent({
      input: request.input,
      systemPrompt: request.systemPrompt,
      modelId: request.modelId,
      region: this.region,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      tools,
      outputSchema: request.outputSchema,
      maxIterations: request.maxIterations,
      invocationState: request.invocationState,
      cancelSignal: request.signal
    });
    const finalOutput = estimateTokens(result.text);
    const seen = last as UsageSnapshot | null;
    const usage =
      seen === null
        ? {
            inputTokens: estimateTokens(request.systemPrompt + request.input),
            outputTokens: finalOutput,
            estimated: true
          }
        : {
            inputTokens: seen.inputTokens + seen.latestContextSize + estimateTokens(lastToolOutput),
            outputTokens: seen.outputTokens + finalOutput,
            estimated: true
          };
    return { decision: result.output as T, stopReason: result.stopReason, usage };
  }
}
