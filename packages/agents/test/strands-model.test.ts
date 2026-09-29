import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runUsageOf, withRunUsage } from '../src/model.js';
import type { BoundTool } from '../src/tools.js';

// Capture the Strands agent the Bedrock client builds, and drive its tool callbacks.
interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  callback: (input: unknown, context?: unknown) => Promise<string>;
}
vi.mock('@readysetcloud/agent', () => ({ tool: (def: ToolDef) => def }));
const strands = vi.hoisted(() => ({
  models: [] as Record<string, unknown>[],
  agents: [] as { tools: ToolDef[]; systemPrompt: string }[],
  /** What the agent's metrics report after the run (undefined: no metrics). */
  metrics: undefined as { accumulatedUsage: { inputTokens?: number; outputTokens?: number } } | undefined,
  invoke: vi.fn()
}));
vi.mock('@strands-agents/sdk', () => ({
  BedrockModel: class {
    constructor(config: Record<string, unknown>) {
      strands.models.push(config);
    }
  },
  Agent: class {
    constructor(config: { tools: ToolDef[]; systemPrompt: string }) {
      strands.agents.push(config);
    }
    get metrics() {
      return strands.metrics;
    }
    invoke(input: string, options: unknown) {
      return strands.invoke(input, options);
    }
  }
}));

const { StrandsModelClient } = await import('../src/strands-model.js');

const echo: BoundTool = {
  name: 'get_roster',
  description: 'Roster',
  mutation: false,
  inputSchema: z.object({ teamId: z.string() }),
  call: async (args) => ({ data: args, league: null, warnings: [] })
};

function request(tools: BoundTool[] = [echo]) {
  return {
    modelId: 'us.amazon.nova-pro-v1:0',
    systemPrompt: 'system prompt',
    input: 'input',
    tools,
    maxIterations: 7,
    maxTokens: 2048,
    temperature: 0.4,
    outputSchema: z.object({ summary: z.string() }),
    signal: new AbortController().signal,
    invocationState: { agentId: 'a' }
  };
}

const answer = (summary: string, text = JSON.stringify({ summary })) => ({
  structuredOutput: { summary },
  stopReason: 'endTurn',
  toString: () => text
});

/** Calls the agent's first tool the way Strands would, with its metrics so far. */
async function callTool(context: unknown) {
  return (strands.agents.at(-1) as { tools: ToolDef[] }).tools[0]!.callback({ teamId: 't' }, context);
}

const metrics = (inputTokens: number, outputTokens: number, latestContextSize?: number) => ({
  agent: {
    metrics: {
      accumulatedUsage: { inputTokens, outputTokens },
      ...(latestContextSize === undefined ? {} : { latestContextSize })
    }
  }
});

beforeEach(() => {
  strands.invoke.mockReset();
  strands.metrics = undefined;
});

describe('StrandsModelClient', () => {
  it('runs a one-shot agent with bound tools and trusted state, and reports Bedrock usage', async () => {
    strands.invoke.mockImplementation(async () => {
      const out = await callTool(metrics(100, 20, 50));
      expect(JSON.parse(out)).toEqual({ data: { teamId: 't' }, league: null, warnings: [] });
      strands.metrics = { accumulatedUsage: { inputTokens: 900, outputTokens: 70 } };
      return answer('ok');
    });
    const result = await new StrandsModelClient('us-east-1').run(request());
    expect(strands.models.at(-1)).toEqual({
      region: 'us-east-1',
      modelId: 'us.amazon.nova-pro-v1:0',
      maxTokens: 2048,
      temperature: 0.4
    });
    expect(strands.agents.at(-1)).toMatchObject({ systemPrompt: 'system prompt' });
    expect(strands.agents.at(-1)?.tools[0]).toMatchObject({ name: 'get_roster', description: 'Roster' });
    const [input, options] = strands.invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toBe('input');
    expect(options).toMatchObject({ limits: { turns: 7 }, invocationState: { agentId: 'a' } });
    expect(result.decision).toEqual({ summary: 'ok' });
    expect(result.stopReason).toBe('endTurn');
    // Every turn's usage as Bedrock reported it: not an estimate.
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 70, estimated: false });
  });

  it('estimates from the last tool snapshot when the provider reported nothing', async () => {
    strands.invoke.mockImplementation(async () => {
      await callTool(metrics(100, 20, 50));
      return answer('ok');
    });
    const result = await new StrandsModelClient().run(request());
    // 100 reported + 50 context + the last tool output estimate; 20 reported + final text estimate.
    expect(result.usage.inputTokens).toBeGreaterThan(150);
    expect(result.usage.outputTokens).toBe(20 + Math.ceil('{"summary":"ok"}'.length / 4));
    expect(result.usage.estimated).toBe(true);
  });

  it('estimates usage from the prompt when no tool ran and nothing was reported', async () => {
    strands.metrics = { accumulatedUsage: {} };
    strands.invoke.mockResolvedValue(answer('x', 'abcd'));
    const result = await new StrandsModelClient().run(request([]));
    expect(result.usage).toEqual({
      inputTokens: Math.ceil('system promptinput'.length / 4),
      outputTokens: 1,
      estimated: true
    });
  });

  it('keeps the last usage snapshot when a context has no metrics', async () => {
    strands.invoke.mockImplementation(async () => {
      await callTool({ agent: { metrics: { accumulatedUsage: {} } } });
      await callTool(undefined);
      return answer('x', '');
    });
    const result = await new StrandsModelClient().run(request());
    expect(result.usage.outputTokens).toBe(0);
  });

  it('attaches what a failed multi-turn run spent to its error', async () => {
    const throttled = Object.assign(new Error('rate'), { name: 'ThrottlingException' });
    strands.invoke.mockImplementationOnce(async () => {
      await callTool(metrics(300, 40));
      strands.metrics = { accumulatedUsage: { inputTokens: 1200, outputTokens: 90 } };
      throw throttled;
    });
    const error = await new StrandsModelClient().run(request()).catch((e: unknown) => e);
    // The same error (its name still picks the next model), with every finished turn's usage.
    expect(error).toBe(throttled);
    expect(runUsageOf(error)).toEqual({ inputTokens: 1200, outputTokens: 90, estimated: false });

    // Without provider metrics, the last snapshot is the estimate; with no turn seen, nothing.
    strands.metrics = undefined;
    strands.invoke.mockImplementationOnce(async () => {
      await callTool(metrics(300, 40));
      throw new Error('aborted');
    });
    const partial = await new StrandsModelClient().run(request()).catch((e: unknown) => e);
    expect(runUsageOf(partial)).toMatchObject({ outputTokens: 40, estimated: true });
    strands.invoke.mockRejectedValueOnce(new Error('denied'));
    expect(runUsageOf(await new StrandsModelClient().run(request()).catch((e: unknown) => e))).toBeNull();
    // Only an object can carry usage.
    const usage = { inputTokens: 1, outputTokens: 1, estimated: false };
    expect(withRunUsage('text', usage)).toBe('text');
    expect(runUsageOf('text')).toBeNull();
  });

  it('sends a thinking budget as a Bedrock request field, without a temperature', async () => {
    strands.invoke.mockResolvedValueOnce(answer('thought'));
    const run = {
      ...request(),
      modelId: 'us.anthropic.claude-opus-5',
      maxTokens: 8192,
      thinkingBudgetTokens: 4096
    };
    const result = await new StrandsModelClient('us-east-1').run(run);
    expect(strands.models.at(-1)).toEqual({
      region: 'us-east-1',
      modelId: 'us.anthropic.claude-opus-5',
      maxTokens: 8192,
      additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: 4096 } }
    });
    expect(result.decision).toEqual({ summary: 'thought' });

    strands.metrics = { accumulatedUsage: { inputTokens: 10, outputTokens: 5 } };
    strands.invoke.mockResolvedValueOnce({
      structuredOutput: undefined,
      stopReason: 'endTurn',
      toString: () => ''
    });
    const error = await new StrandsModelClient().run(run).catch((e: unknown) => e);
    expect(String(error)).toContain('no structured answer');
    expect(runUsageOf(error)).toEqual({ inputTokens: 10, outputTokens: 5, estimated: false });
  });
});
