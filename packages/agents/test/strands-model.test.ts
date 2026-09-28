import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BoundTool } from '../src/tools.js';

// Capture what the Bedrock client hands @readysetcloud/agent, and drive its tool callbacks.
interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  callback: (input: unknown, context?: unknown) => Promise<string>;
}
const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('@readysetcloud/agent', () => ({
  tool: (def: ToolDef) => def,
  runAgent
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

beforeEach(() => {
  runAgent.mockReset();
});

describe('StrandsModelClient', () => {
  it('passes the run through runAgent with bound tools and trusted state', async () => {
    runAgent.mockImplementation(async (options: { tools: ToolDef[] }) => {
      const out = await options.tools[0]!.callback(
        { teamId: 't' },
        {
          agent: {
            metrics: { accumulatedUsage: { inputTokens: 100, outputTokens: 20 }, latestContextSize: 50 }
          }
        }
      );
      expect(JSON.parse(out)).toEqual({ data: { teamId: 't' }, league: null, warnings: [] });
      return {
        output: { summary: 'ok' },
        text: '{"summary":"ok"}',
        structured: true,
        stopReason: 'endTurn',
        invocationState: {}
      };
    });
    const result = await new StrandsModelClient('us-east-1').run(request());
    const options = runAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      modelId: 'us.amazon.nova-pro-v1:0',
      systemPrompt: 'system prompt',
      region: 'us-east-1',
      maxIterations: 7,
      maxTokens: 2048,
      temperature: 0.4,
      invocationState: { agentId: 'a' }
    });
    expect((options.tools as ToolDef[])[0]).toMatchObject({ name: 'get_roster', description: 'Roster' });
    expect(result.decision).toEqual({ summary: 'ok' });
    expect(result.stopReason).toBe('endTurn');
    // 100 reported + 50 context + the last tool output estimate; 20 reported + final text estimate.
    expect(result.usage.inputTokens).toBeGreaterThan(150);
    expect(result.usage.outputTokens).toBe(20 + Math.ceil('{"summary":"ok"}'.length / 4));
    expect(result.usage.estimated).toBe(true);
  });

  it('estimates usage when no tool ran', async () => {
    runAgent.mockResolvedValue({
      output: { summary: 'x' },
      text: 'abcd',
      structured: true,
      stopReason: 'endTurn',
      invocationState: {}
    });
    const result = await new StrandsModelClient().run(request([]));
    expect(result.usage).toEqual({
      inputTokens: Math.ceil('system promptinput'.length / 4),
      outputTokens: 1,
      estimated: true
    });
  });

  it('keeps the last usage snapshot when a context has no metrics', async () => {
    runAgent.mockImplementation(async (options: { tools: ToolDef[] }) => {
      await options.tools[0]!.callback({ teamId: 't' }, { agent: { metrics: { accumulatedUsage: {} } } });
      await options.tools[0]!.callback({ teamId: 't' }, undefined);
      return {
        output: { summary: 'x' },
        text: '',
        structured: true,
        stopReason: 'endTurn',
        invocationState: {}
      };
    });
    const result = await new StrandsModelClient().run(request());
    expect(result.usage.outputTokens).toBe(0);
  });
});
