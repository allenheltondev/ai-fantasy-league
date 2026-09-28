import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedModelClient } from '../src/fake-model.js';
import {
  estimateTokens,
  isModelUnavailable,
  ModelUnavailableError,
  type ModelRunRequest
} from '../src/model.js';
import { applySwaps } from '../src/tasks/lineup.js';
import { createTaskKindRegistry } from '../src/tasks/kinds.js';
import { noopTask } from '../src/tasks/noop.js';
import type { BoundTool } from '../src/tools.js';

describe('model helpers', () => {
  it('classifies unavailable-model errors', () => {
    expect(isModelUnavailable(new ModelUnavailableError('x'))).toBe(true);
    expect(isModelUnavailable(Object.assign(new Error('x'), { name: 'ThrottlingException' }))).toBe(true);
    expect(isModelUnavailable(new Error('The provided model identifier is invalid.'))).toBe(true);
    expect(isModelUnavailable(new Error('boom'))).toBe(false);
    expect(isModelUnavailable('nope')).toBe(false);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});

function request(
  overrides: Partial<ModelRunRequest<{ summary: string }>> = {}
): ModelRunRequest<{ summary: string }> {
  return {
    modelId: 'm',
    systemPrompt: 's',
    input: 'i',
    tools: [],
    maxIterations: 5,
    maxTokens: 100,
    temperature: 0.5,
    outputSchema: z.object({ summary: z.string() }),
    signal: new AbortController().signal,
    invocationState: {},
    ...overrides
  };
}

describe('ScriptedModelClient', () => {
  const echo: BoundTool = {
    name: 'echo',
    description: 'd',
    mutation: false,
    inputSchema: z.object({}),
    call: async (args) => ({ data: args, league: null, warnings: [] })
  };

  it('defaults to doing nothing', async () => {
    const result = await new ScriptedModelClient().run(request());
    expect(result).toMatchObject({
      decision: { summary: 'No action (fake model).' },
      usage: { estimated: true }
    });
  });

  it('stops at maxIterations, reports unknown tools, and honors aborts', async () => {
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [
          { tool: 'nope', args: {} },
          { tool: 'echo', args: { a: 1 } },
          { tool: 'echo', args: { a: 2 } }
        ],
        decision: { summary: 'done' }
      })
    });
    await model.run(request({ tools: [echo], maxIterations: 2 }));
    expect(model.transcript[0]?.results).toEqual([
      { error: { code: 'NOT_FOUND', message: 'Unknown tool nope', fix: 'Use a listed tool.' } },
      { data: { a: 1 }, league: null, warnings: [] }
    ]);
    const aborted = new AbortController();
    aborted.abort(new Error('late'));
    await expect(model.run(request({ tools: [echo], signal: aborted.signal }))).rejects.toBeInstanceOf(
      ModelUnavailableError
    );
  });
});

describe('lineup swaps and task registry', () => {
  it('swaps known players and ignores unknown ones', () => {
    const lineup = [
      { playerId: 'a', slot: 'QB' as const },
      { playerId: 'b', slot: 'BN' as const }
    ];
    expect(
      applySwaps(lineup, [
        { bench: 'b', starter: 'a' },
        { bench: 'x', starter: 'a' }
      ])
    ).toEqual([
      { playerId: 'a', slot: 'BN' },
      { playerId: 'b', slot: 'QB' }
    ]);
  });

  it('rejects duplicate task kinds', () => {
    expect(() => createTaskKindRegistry([noopTask, noopTask])).toThrow(/Duplicate task kind/);
    expect(createTaskKindRegistry([noopTask]).kinds).toEqual(['noop']);
  });
});
