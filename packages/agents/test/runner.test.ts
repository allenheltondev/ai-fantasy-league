import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import type { ModelClient, ModelRunRequest, ModelRunResult } from '../src/model.js';
import { runAgentAction } from '../src/runner.js';
import { lineupTask } from '../src/tasks/lineup.js';
import { noopTask } from '../src/tasks/noop.js';
import { BaseDecisionSchema, createTaskKindRegistry, defineTaskKind } from '../src/tasks/kinds.js';
import { AGENT_TEAM, LEAGUE_ID, setup } from './support.js';

const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;
const PRO = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;

function request(overrides: Partial<AgentActionRequested> = {}): AgentActionRequested {
  return {
    taskId: 'lineup.evt1',
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: AGENT_ID,
    kind: 'lineup',
    trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt-1', urgent: true },
    payload: { reason: 'lock', week: 5 },
    requestedAt: '2026-10-04T15:00:00.000Z',
    ...overrides
  };
}

function starters(lineup: unknown): Record<string, string> {
  return Object.fromEntries(
    (lineup as { playerId: string; slot: string }[])
      .filter((e) => e.slot !== 'BN')
      .map((e) => [e.playerId, e.slot])
  );
}

describe('runAgentAction with the fake model', () => {
  it('confirms the optimizer lineup through real operations and records everything', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    const model = new ScriptedModelClient({
      script: () => ({
        steps: [{ tool: 'get_news', args: { playerId: 'rb3' } }],
        decision: { summary: 'Start the optimizer lineup.', confirm: true, memoryNote: 'rb3 is my guy.' }
      })
    });
    const record = await runAgentAction(s.deps(model), request());
    expect(record).toMatchObject({
      status: 'completed',
      fallbackReason: null,
      finalAction: 'set_lineup',
      reasoningSummary: 'Start the optimizer lineup.',
      week: 5,
      trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt-1' }
    });
    expect(record.toolsCalled.map((c) => c.name)).toEqual([
      'get_news',
      'get_roster',
      'get_projections',
      'set_lineup'
    ]);
    expect(record.usage).toHaveLength(1);
    expect(record.usage[0]).toMatchObject({ modelKey: 'kimi-k2-thinking', estimatedTokens: true });
    expect(record.costUsd).toBeGreaterThan(0);
    expect(model.transcript[0]?.modelId).toBe('moonshot.kimi-k2-thinking');
    expect(model.transcript[0]?.systemPrompt).toContain('The Spreadsheet');
    expect(model.transcript[0]?.systemPrompt).toContain('RB: RB3 (rb3, 30 pts)');
    expect(s.state.lineups).toHaveLength(1);
    expect(starters(s.state.lineups[0]?.lineup)).toMatchObject({
      qb1: 'QB',
      rb3: 'RB',
      rb1: 'RB',
      rb2: 'W/R/T'
    });
    expect(await s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID)).toEqual(['rb3 is my guy.']);
    expect(await s.repos.agents.weekUsage(LEAGUE_ID, 5)).toEqual([
      expect.objectContaining({ agentId: AGENT_ID, modelKey: 'kimi-k2-thinking', tasks: 1 })
    ]);
    expect((await s.repos.agents.listTasks(LEAGUE_ID))[0]).toEqual(record);
    expect(s.logs.some((l) => l.includes('agent task finished'))).toBe(true);

    // Idempotent per trigger: a redelivery returns the stored record without acting again.
    const replay = await runAgentAction(s.deps(model), request());
    expect(replay).toEqual(record);
    expect(model.transcript).toHaveLength(1);
    expect(s.state.lineups).toHaveLength(1);
  });

  it('uses the task kind default script and the memory in the prompt', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    await s.repos.agents.appendMemory(LEAGUE_ID, AGENT_ID, 'Team 3 fleeced me in week 2.', 20);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request());
    expect(record.reasoningSummary).toMatch(/Going with the optimizer/);
    expect(model.transcript[0]?.systemPrompt).toContain('Team 3 fleeced me in week 2.');
    expect(model.transcript[0]?.toolNames).not.toContain('set_lineup');
  });

  it('applies legal swaps and rejects illegal ones', async () => {
    const legal = await setup();
    await legal.seat(AGENT_TEAM, PRO);
    const swap = (bench: string, starter: string) =>
      new ScriptedModelClient({
        script: () => ({
          steps: [],
          decision: { summary: 'Swap.', confirm: false, swaps: [{ bench, starter }] }
        })
      });
    await runAgentAction(legal.deps(swap('te2', 'te1')), request());
    expect(starters(legal.state.lineups[0]?.lineup)).toMatchObject({ te2: 'TE' });

    const illegal = await setup();
    await illegal.seat(AGENT_TEAM, PRO);
    const record = await runAgentAction(illegal.deps(swap('k1', 'qb1')), request());
    expect(record.reasoningSummary).toContain('not legal');
    expect(starters(illegal.state.lineups[0]?.lineup)).toMatchObject({ qb1: 'QB', k1: 'K' });
  });

  it('does nothing when the lineup is already optimal', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    await runAgentAction(s.deps(new ScriptedModelClient()), request());
    const optimal = s.state.lineups[0]?.lineup as { playerId: string; slot: string }[];
    s.state.rosters.set(
      AGENT_TEAM,
      (s.state.rosters.get(AGENT_TEAM) ?? []).map((r) => ({
        ...r,
        slot: optimal.find((e) => e.playerId === r.playerId)?.slot ?? 'BN'
      }))
    );
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      request({ taskId: 'lineup.evt2' })
    );
    expect(record.finalAction).toBe('lineup_unchanged');
    expect(s.state.lineups).toHaveLength(1);
  });

  describe('deterministic fallbacks', () => {
    it('uses the optimizer when the kill switch is on, without calling a model', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const model = new ScriptedModelClient();
      const record = await runAgentAction(
        s.deps(model, { killSwitch: { engaged: async () => true } }),
        request()
      );
      expect(record).toMatchObject({
        status: 'fallback',
        fallbackReason: 'kill_switch',
        finalAction: 'set_lineup',
        usage: []
      });
      expect(model.transcript).toHaveLength(0);
      expect(starters(s.state.lineups[0]?.lineup)).toMatchObject({ rb3: 'RB' });
    });

    it('uses the optimizer when the league is over its weekly budget', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      await s.repos.agents.addUsage({
        leagueId: LEAGUE_ID,
        week: 5,
        agentId: AGENT_ID,
        modelKey: 'claude-opus-5',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 100,
        tasks: 1
      });
      const model = new ScriptedModelClient();
      const record = await runAgentAction(s.deps(model), request());
      expect(record).toMatchObject({ status: 'fallback', fallbackReason: 'budget_exceeded' });
      expect(model.transcript).toHaveLength(0);
      expect(s.logs.some((l) => l.includes('budget exceeded'))).toBe(true);
    });

    it('moves down the model chain when a model is unavailable', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
      const model = new ScriptedModelClient({
        fail: (id) => (id === 'moonshot.kimi-k2-thinking' ? throttled : undefined)
      });
      const record = await runAgentAction(s.deps(model), request());
      expect(record.status).toBe('completed');
      expect(record.usage[0]?.modelKey).toBe('nova-pro');
    });

    it('falls back when every model is unavailable', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const model = new ScriptedModelClient({
        fail: () => Object.assign(new Error('no access'), { name: 'AccessDeniedException' })
      });
      const record = await runAgentAction(s.deps(model), request());
      expect(record).toMatchObject({
        status: 'fallback',
        fallbackReason: 'models_unavailable',
        finalAction: 'set_lineup'
      });
    });

    it('falls back on a model error', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const model = new ScriptedModelClient({ script: () => ({ steps: [], decision: { nope: true } }) });
      const record = await runAgentAction(s.deps(model), request());
      expect(record).toMatchObject({
        status: 'fallback',
        fallbackReason: 'model_error',
        finalAction: 'set_lineup'
      });
    });

    it('falls back on a timeout', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const hanging: ModelClient = {
        name: 'hanging',
        run: <T>(req: ModelRunRequest<T>) =>
          new Promise<ModelRunResult<T>>((_resolve, reject) => {
            req.signal.addEventListener('abort', () => reject(req.signal.reason));
          })
      };
      const record = await runAgentAction(s.deps(hanging, { modelTimeoutMs: 10 }), request());
      expect(record).toMatchObject({ status: 'fallback', fallbackReason: 'timeout' });
    });

    it('records a failed fallback', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const broken = defineTaskKind({
        ...noopTaskSpec(),
        fallback: async () => {
          throw new Error('cannot');
        }
      });
      const record = await runAgentAction(
        s.deps(new ScriptedModelClient(), {
          kinds: createTaskKindRegistry([broken]),
          killSwitch: { engaged: async () => true }
        }),
        request({ kind: 'noop', payload: {} })
      );
      expect(record).toMatchObject({
        status: 'failed',
        fallbackReason: 'kill_switch',
        reasoningSummary: 'Fallback failed: cannot'
      });
    });

    it('records a decision that cannot be applied', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const broken = defineTaskKind({
        ...noopTaskSpec(),
        apply: async () => {
          throw new Error('bad apply');
        }
      });
      const record = await runAgentAction(
        s.deps(new ScriptedModelClient(), { kinds: createTaskKindRegistry([broken]) }),
        request({ kind: 'noop', payload: {} })
      );
      expect(record).toMatchObject({
        status: 'failed',
        reasoningSummary: 'Could not apply the decision: bad apply'
      });
    });
  });

  describe('skips', () => {
    it.each([
      ['unknown_kind', { kind: 'trade_response' }],
      ['no_agent_seat', { teamId: 'team-3' }],
      ['no_agent_seat', { agentId: 'someone-else' }],
      ['league_not_found', { leagueId: 'nope' }]
    ] as const)('%s', async (reason, overrides) => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const record = await runAgentAction(s.deps(new ScriptedModelClient()), request(overrides));
      expect(record).toMatchObject({ status: 'skipped', fallbackReason: reason });
    });

    it('skips when the lineup tools do not exist yet', async () => {
      const s = await setup({ withLineupOps: false });
      await s.seat(AGENT_TEAM, PRO);
      const record = await runAgentAction(s.deps(new ScriptedModelClient()), request());
      expect(record.status).toBe('skipped');
      expect(record.fallbackReason).toMatch(/get_roster failed: FORBIDDEN/);
    });

    it('skips when prepare throws unexpectedly', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const record = await runAgentAction(
        s.deps(new ScriptedModelClient()),
        request({ payload: { week: 99 } })
      );
      expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'prepare_failed' });
    });

    it('reports a task another container is running', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      await s.repos.agents.claimTask({
        taskId: 'lineup.evt1',
        now: s.clock.now(),
        lockUntil: new Date('2030-01-01')
      });
      const record = await runAgentAction(s.deps(new ScriptedModelClient()), request());
      expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'in_progress' });
      expect(await s.repos.agents.listTasks(LEAGUE_ID)).toEqual([]);
    });
  });

  it('uses the chat model chain for chat-role kinds', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, { ...PRO, difficulty: 'hall_of_famer' });
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      request({ kind: 'noop', payload: { note: 'bye week' } })
    );
    expect(record).toMatchObject({
      status: 'completed',
      finalAction: 'none',
      reasoningSummary: 'Checked in; nothing to do.'
    });
    expect(model.transcript[0]?.modelId).toBe('moonshot.kimi-k2-thinking');
    expect(model.transcript[0]?.input).toContain('Lineup Lock Approaching');
  });

  describe('security', () => {
    it('cannot act for another team', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const model = new ScriptedModelClient({
        script: (req) => ({
          steps: [
            { tool: 'get_roster', args: { teamId: 'team-3' } },
            { tool: 'set_lineup', args: { teamId: 'team-3', lineup: [] } }
          ],
          decision: { summary: `tools: ${req.tools.length}`, confirm: true }
        })
      });
      const kinds = createTaskKindRegistry([defineTaskKind({ ...lineupSpecWithAllTools() })]);
      const record = await runAgentAction(s.deps(model, { kinds }), request());
      const results = model.transcript[0]?.results as { data?: unknown; error?: { code: string } }[];
      expect(results[0]).toHaveProperty('data');
      expect(results[1]).toMatchObject({
        error: { code: 'FORBIDDEN', message: 'You can only act for your own team.' }
      });
      expect(s.state.lineups.every((l) => l.teamId === AGENT_TEAM)).toBe(true);
      expect(record.toolsCalled).toContainEqual({
        name: 'set_lineup',
        mutation: true,
        ok: false,
        errorCode: 'FORBIDDEN'
      });
    });

    it('cannot reach a tool outside its research access or task', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, { ...PRO, difficulty: 'rookie' });
      const model = new ScriptedModelClient({
        script: () => ({
          steps: [
            { tool: 'get_news', args: {} },
            {
              tool: 'configure_agent_seat',
              args: {
                teamId: AGENT_TEAM,
                personalityId: 'hype-man',
                difficulty: 'hall_of_famer',
                archetype: 'win_now'
              }
            }
          ],
          decision: { summary: 'Tried.', confirm: true }
        })
      });
      await runAgentAction(s.deps(model), request());
      expect(model.transcript[0]?.toolNames).not.toContain('get_news');
      expect(model.transcript[0]?.toolNames).not.toContain('configure_agent_seat');
      expect(model.transcript[0]?.results).toEqual([
        expect.objectContaining({ error: expect.objectContaining({ code: 'NOT_FOUND' }) }),
        expect.objectContaining({ error: expect.objectContaining({ code: 'NOT_FOUND' }) })
      ]);
      expect((await s.repos.agents.getSeat(LEAGUE_ID, AGENT_TEAM))?.config.difficulty).toBe('rookie');
    });
  });
});

function noopTaskSpec() {
  return {
    kind: 'noop',
    title: 'Check in',
    modelRole: 'chat' as const,
    payload: z.object({}),
    decision: BaseDecisionSchema,
    prepare: async () => null,
    instructions: () => 'Do nothing.',
    apply: async () => ({ action: 'none', summary: 'ok' }),
    fallback: async () => ({ action: 'none', summary: 'ok' })
  };
}

/** The lineup kind, but letting the model call set_lineup itself (to probe the own-team guard). */
function lineupSpecWithAllTools() {
  return {
    kind: 'lineup',
    title: 'Set your lineup',
    modelRole: 'decision' as const,
    payload: z.record(z.string(), z.unknown()),
    decision: BaseDecisionSchema.extend({ confirm: z.boolean() }),
    prepare: async () => null,
    instructions: () => 'Set your lineup.',
    apply: async () => ({ action: 'none', summary: 'ok' }),
    fallback: async () => ({ action: 'none', summary: 'ok' })
  };
}

// Keep the shipped kinds referenced so their registration is covered here too.
void lineupTask;
void noopTask;
