import { tool } from '@readysetcloud/agent';
import { Agent, BedrockModel, type JSONValue } from '@strands-agents/sdk';
import { MODEL_REGION } from '@fantasy/core';
import type { z } from 'zod';
import {
  estimateTokens,
  withRunUsage,
  type ModelClient,
  type ModelRunRequest,
  type ModelRunResult,
  type ModelUsage
} from './model.js';

/**
 * The Bedrock model client: a stateless one-shot Strands agent (what `@readysetcloud/agent`'s
 * `runAgent` builds) with structured output (`outputSchema`), a bounded tool loop (`maxIterations`,
 * the SDK's `limits.turns`), trusted context (`invocationState`), and a cancel signal. We build the
 * agent here rather than calling `runAgent` because the run's token usage lives on the agent, which
 * `runAgent` does not return. A league task needs none of the rsc-core session/snapshot plumbing:
 * idempotency is our own claim on the task id in the league table, and the result is the structured
 * decision, not chat text.
 *
 * Token usage (#209): the agent's `metrics.accumulatedUsage` is the sum of the `usage` Bedrock's
 * Converse API reported for every model turn of the run, so it is used as is (`estimated: false`),
 * for a failed run too: the error carries what the finished turns spent (`withRunUsage`). Only when
 * the provider reported nothing is usage estimated: from the last tool callback's snapshot of those
 * metrics plus the final turn's context and text, or from the prompt alone (`estimated: true`).
 *
 * Reasoning effort: for catalog models that take an extended-thinking budget the runner sets
 * `thinkingBudgetTokens`, and the run goes to Bedrock with Anthropic's `thinking` request field; for
 * models on adaptive thinking it sets `thinkingEffort` (`thinkingRequestFields`). Strands drops
 * `thinking` by itself on a turn that forces a tool (the structured answer), which Bedrock does not
 * allow together; temperature is left unset because thinking only accepts the default.
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

/** What Bedrock reported for the whole run, or null when it reported nothing. */
function reported(agent: unknown): ModelUsage | null {
  const usage = snapshot({ agent });
  if (usage === null || usage.inputTokens + usage.outputTokens <= 0) return null;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated: false };
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
    const thinking = thinkingRequestFields(request);
    const agent = new Agent({
      model: new BedrockModel({
        region: this.region,
        modelId: request.modelId,
        maxTokens: request.maxTokens,
        ...(thinking === undefined
          ? { temperature: request.temperature }
          : { additionalRequestFields: thinking })
      }),
      systemPrompt: request.systemPrompt,
      tools
    });
    const estimate = (finalText: string): ModelUsage => {
      const seen = last as UsageSnapshot | null;
      return seen === null
        ? {
            inputTokens: estimateTokens(request.systemPrompt + request.input),
            outputTokens: estimateTokens(finalText),
            estimated: true
          }
        : {
            inputTokens: seen.inputTokens + seen.latestContextSize + estimateTokens(lastToolOutput),
            outputTokens: seen.outputTokens + estimateTokens(finalText),
            estimated: true
          };
    };
    let result: Awaited<ReturnType<Agent['invoke']>>;
    try {
      result = await agent.invoke(request.input, {
        structuredOutputSchema: request.outputSchema as z.ZodType,
        limits: { turns: request.maxIterations },
        invocationState: request.invocationState,
        cancelSignal: request.signal
      });
    } catch (error) {
      throw withRunUsage(error, reported(agent) ?? (last === null ? null : estimate('')));
    }
    const text = result.toString();
    const usage = reported(agent) ?? estimate(text);
    if (result.structuredOutput === undefined) {
      throw withRunUsage(new Error('The model returned no structured answer.'), usage);
    }
    return { decision: result.structuredOutput as T, stopReason: result.stopReason, usage };
  }
}

/**
 * Bedrock request fields for a thinking run: a budget for models that take one, or adaptive
 * thinking with an effort for the Claude 5 models, which reject `thinking.type: enabled`.
 */
function thinkingRequestFields(request: ModelRunRequest<unknown>): Record<string, JSONValue> | undefined {
  if (request.thinkingEffort !== undefined)
    return { thinking: { type: 'adaptive' }, output_config: { effort: request.thinkingEffort } };
  if (request.thinkingBudgetTokens !== undefined)
    return { thinking: { type: 'enabled', budget_tokens: request.thinkingBudgetTokens } };
  return undefined;
}
