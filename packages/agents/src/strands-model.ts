import { runAgent, tool } from '@readysetcloud/agent';
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { MODEL_REGION } from '@fantasy/core';
import type { z } from 'zod';
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
 *
 * Reasoning effort: for catalog models that take an extended-thinking budget the runner sets
 * `thinkingBudgetTokens`, and the run goes to Bedrock with Anthropic's `thinking` request field.
 * `runAgent` cannot pass request fields, so those runs build the same one-shot Strands agent here
 * (`runThinking`). Strands drops `thinking` by itself on a turn that forces a tool (the structured
 * answer), which Bedrock does not allow together; temperature is left unset because thinking only
 * accepts the default.
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
    const result =
      request.thinkingBudgetTokens === undefined
        ? await runAgent({
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
          })
        : await runThinking(request, tools, this.region, request.thinkingBudgetTokens);
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

/** `runAgent` with an extended-thinking budget (see the file comment). */
async function runThinking<T>(
  request: ModelRunRequest<T>,
  tools: ReturnType<typeof tool>[],
  region: string,
  budgetTokens: number
): Promise<{ output: unknown; text: string; stopReason: string }> {
  const agent = new Agent({
    model: new BedrockModel({
      region,
      modelId: request.modelId,
      maxTokens: request.maxTokens,
      additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: budgetTokens } }
    }),
    systemPrompt: request.systemPrompt,
    tools
  });
  const result = await agent.invoke(request.input, {
    structuredOutputSchema: request.outputSchema as z.ZodType,
    limits: { turns: request.maxIterations },
    invocationState: request.invocationState,
    cancelSignal: request.signal
  });
  if (result.structuredOutput === undefined) throw new Error('The model returned no structured answer.');
  return { output: result.structuredOutput, text: result.toString(), stopReason: result.stopReason };
}
