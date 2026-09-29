import { rememberEvent } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import type { ModelClient, ModelRunRequest, ModelRunResult } from '../src/model.js';
import { taskIdFor } from '../src/router.js';
import { recoverAgentTasks } from '../src/recovery.js';
import { runAgentAction } from '../src/runner.js';
import { lineupTask } from '../src/tasks/lineup.js';
import { noopTask } from '../src/tasks/noop.js';
import { BaseDecisionSchema, createTaskKindRegistry, defineTaskKind } from '../src/tasks/kinds.js';
import { AGENT_TEAM, LEAGUE_ID, SF_KICKOFF, setup } from './support.js';

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
    expect(record.toolsCalled.map((c) => c.name)).toEqual(['get_news', 'get_roster', 'set_lineup']);
    expect(record.usage).toHaveLength(1);
    expect(record.usage[0]).toMatchObject({ modelKey: 'kimi-k2-thinking', estimatedTokens: true });
    expect(record.costUsd).toBeGreaterThan(0);
    expect(model.transcript[0]?.modelId).toBe('moonshot.kimi-k2-thinking');
    expect(model.transcript[0]?.systemPrompt).toContain('The Spreadsheet');
    expect(model.transcript[0]?.systemPrompt).toContain('RB: RB3 (rb3, 30 pts)');
    const saved = await s.savedLineups();
    expect(saved).toHaveLength(1);
    expect(starters(saved[0]?.lineup)).toMatchObject({
      qb1: 'QB',
      rb3: 'RB',
      rb1: 'RB',
      rb2: 'W/R/T'
    });
    const memory = await s.repos.agents.getMemory(LEAGUE_ID, AGENT_ID);
    // A lineup is nobody's secret: its note is public.
    expect(memory.notes).toEqual([{ text: 'rb3 is my guy.', at: expect.any(String), visibility: 'public' }]);
    expect(memory.decisions).toEqual([
      expect.objectContaining({
        kind: 'lineup',
        action: 'set_lineup',
        summary: 'Start the optimizer lineup.'
      })
    ]);
    expect(await s.repos.agents.weekUsage(LEAGUE_ID, 5)).toEqual([
      expect.objectContaining({ agentId: AGENT_ID, modelKey: 'kimi-k2-thinking', tasks: 1 })
    ]);
    expect((await s.repos.agents.listTasks(LEAGUE_ID))[0]).toEqual(record);
    expect(s.logs.some((l) => l.includes('agent task finished'))).toBe(true);

    // Idempotent per trigger: a redelivery returns the stored record without acting again.
    const replay = await runAgentAction(s.deps(model), request());
    expect(replay).toEqual(record);
    expect(model.transcript).toHaveLength(1);
    expect(await s.savedLineups()).toEqual(saved);
  });

  it('uses the task kind default script and the memory in the prompt', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    await s.repos.agents.updateMemory(LEAGUE_ID, AGENT_ID, (m) =>
      rememberEvent(m, { type: 'note', text: 'Team 3 fleeced me in week 2.', visibility: 'public' })
    );
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
    expect(starters((await legal.savedLineups())[0]?.lineup)).toMatchObject({ te2: 'TE' });

    const illegal = await setup();
    await illegal.seat(AGENT_TEAM, PRO);
    const record = await runAgentAction(illegal.deps(swap('k1', 'qb1')), request());
    expect(record.reasoningSummary).toContain('not legal');
    expect(starters((await illegal.savedLineups())[0]?.lineup)).toMatchObject({ qb1: 'QB', k1: 'K' });
  });

  it('tells the model which players are already locked, from the shared game state (#193)', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    // SF, every rostered player's team, kicked off ten minutes ago.
    s.clock.set(new Date(Date.parse(SF_KICKOFF) + 10 * 60_000));
    const model = new ScriptedModelClient();
    const record = await runAgentAction(s.deps(model), request());
    expect(model.transcript[0]?.systemPrompt).toContain('Already locked, their games have started');
    expect(model.transcript[0]?.systemPrompt).toContain('RB3');
    // Nothing can move once everyone is locked.
    expect(record.finalAction).toBe('lineup_unchanged');
  });

  it('skips a kickoff none of its players play in, without a model call (#193)', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    const model = new ScriptedModelClient();
    const record = await runAgentAction(
      s.deps(model),
      request({ payload: { reason: 'lock', week: 5, nflTeams: ['BUF', 'MIA'] } })
    );
    expect(record.status).toBe('skipped');
    expect(model.transcript).toHaveLength(0);
    // Its SF players kick off then: it goes to work.
    const again = await runAgentAction(
      s.deps(model),
      request({ taskId: 'lineup.sf', payload: { reason: 'lock', week: 5, nflTeams: ['SF', 'DAL'] } })
    );
    expect(again.status).toBe('completed');
    expect(model.transcript).toHaveLength(1);
  });

  it('does nothing when the lineup is already optimal', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    await runAgentAction(s.deps(new ScriptedModelClient()), request());
    const optimal = await s.savedLineups();
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient()),
      request({ taskId: 'lineup.evt2' })
    );
    expect(record.finalAction).toBe('lineup_unchanged');
    expect(await s.savedLineups()).toEqual(optimal);
  });

  it('leaves locked players alone once their game kicks off', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    s.clock.set(new Date(Date.parse(SF_KICKOFF) + 60_000));
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), request());
    expect(record.finalAction).toBe('lineup_unchanged');
    expect(await s.savedLineups()).toEqual([]);
  });

  it('records a refused set_lineup (outside the season) instead of failing', async () => {
    const s = await setup({ league: { phase: 'drafting' } });
    await s.seat(AGENT_TEAM, PRO);
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), request());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'set_lineup_failed' });
    expect(record.reasoningSummary).toContain('not allowed');
  });

  it('still sets a lineup when the week has no stored games', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    await s.services.data.reference.schedule.putSeason(2026, [], {}, s.clock.now());
    const record = await runAgentAction(s.deps(new ScriptedModelClient()), request());
    expect(record.finalAction).toBe('set_lineup');
    expect(starters((await s.savedLineups())[0]?.lineup)).toMatchObject({ qb1: 'QB', rb3: 'RB' });
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
      expect(starters((await s.savedLineups())[0]?.lineup)).toMatchObject({ rb3: 'RB' });
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
      // The league hears about it once per budget week, not once per task.
      await runAgentAction(s.deps(model), request({ taskId: 'lineup.again' }));
      const notices = s.events.events.filter((e) => e.detailType === 'Agent Budget Exceeded');
      expect(notices.map((e) => e.detail)).toEqual([
        { leagueId: LEAGUE_ID, week: 5, spentUsd: 100, ceilingUsd: 0.5 }
      ]);
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
      // The failed run still counts against the budget, as an estimate.
      expect(record.usage).toEqual([
        expect.objectContaining({ modelKey: 'kimi-k2-thinking', outputTokens: 2048, estimatedTokens: true })
      ]);
      expect(record.costUsd).toBeGreaterThan(0);
      expect((await s.repos.agents.weekUsage(LEAGUE_ID, 5)).map((r) => r.modelKey)).toEqual([
        'kimi-k2-thinking'
      ]);
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
      expect(record.usage[0]).toMatchObject({ inputTokens: expect.any(Number), outputTokens: 2048 });
      expect(record.usage[0]?.inputTokens).toBeGreaterThan(100);
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
      // A permanent failure (a bug, not throttling) is recorded at once; the error's message, which
      // could quote sealed details, stays out of the summary.
      expect(record).toMatchObject({
        status: 'failed',
        fallbackReason: 'kill_switch',
        reasoningSummary: 'Fallback failed (Error).'
      });
    });

    it('falls back when a decision cannot be applied and nothing was done yet', async () => {
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
        status: 'fallback',
        fallbackReason: 'apply_failed',
        reasoningSummary: 'ok'
      });
    });
  });

  describe('skips', () => {
    it.each([
      ['unknown_kind', { kind: 'not_a_kind' }],
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

    it('records a failure (not a skip) when prepare throws a permanent error', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const record = await runAgentAction(
        s.deps(new ScriptedModelClient()),
        request({ payload: { week: 99 } })
      );
      expect(record).toMatchObject({
        status: 'failed',
        fallbackReason: 'prepare_failed',
        reasoningSummary: 'Could not prepare the task (ZodError).'
      });
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

  it('requests follow-up tasks from an outcome, and a failed request is kept for the relay', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    const handOff = {
      ...noopTaskSpec(),
      kind: 'kickoff',
      apply: async () => ({
        action: 'none',
        summary: 'ok',
        followUps: [
          { kind: 'noop', payload: { note: 'now' } },
          { kind: 'noop2', payload: {}, delayMs: 60_000 }
        ]
      })
    };
    const kinds = createTaskKindRegistry([defineTaskKind(handOff)]);
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient(), { kinds }),
      request({ kind: 'kickoff', payload: {} })
    );
    expect(record.status).toBe('completed');
    expect(s.events.events.find((e) => e.detailType === 'Agent Action Requested')?.detail).toMatchObject({
      taskId: taskIdFor('evt-1', AGENT_TEAM, 'noop'),
      kind: 'noop',
      payload: { note: 'now' },
      trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt-1' }
    });
    const later = s.events.events.find((e) => e.detailType === 'Schedule Event')?.detail as {
      at: string;
      event: { detail: { taskId: string } };
    };
    expect(Date.parse(later.at) - s.clock.now().getTime()).toBe(60_000);
    expect(later.event.detail.taskId).toBe(taskIdFor('evt-1', AGENT_TEAM, 'noop2'));

    // The bus refuses the follow-up: the task's own decision stands, and the follow-up waits in the
    // outbox until the recovery sweep sends it (#207).
    const broken = await setup();
    await broken.seat(AGENT_TEAM, PRO);
    const publish = broken.services.events.publish.bind(broken.services.events);
    broken.services.events.publish = async () => {
      throw new Error('bus down');
    };
    const kept = await runAgentAction(
      broken.deps(new ScriptedModelClient(), { kinds }),
      request({ kind: 'kickoff', payload: {} })
    );
    expect(kept.status).toBe('completed');
    expect(broken.logs.some((l) => l.includes('agent task dispatch failed; the relay will retry'))).toBe(
      true
    );
    const lost = taskIdFor('evt-1', AGENT_TEAM, 'noop');
    expect(await broken.repos.agents.getDispatch(lost)).toMatchObject({ state: 'reserved', attempts: 1 });
    broken.services.events.publish = publish;
    broken.clock.advance(60_000);
    expect(await recoverAgentTasks(broken.services)).toMatchObject({ sent: 1, failed: 0 });
    expect(broken.events.events.find((e) => e.detailType === 'Agent Action Requested')?.detail).toMatchObject(
      {
        taskId: lost
      }
    );
    expect(await broken.repos.agents.getDispatch(lost)).toMatchObject({ state: 'dispatched' });
  });

  describe('security', () => {
    it('cannot act for another team', async () => {
      const s = await setup();
      await s.seat(AGENT_TEAM, PRO);
      const model = new ScriptedModelClient({
        script: (req) => ({
          steps: [
            { tool: 'get_roster', args: { teamId: 'team-3' } },
            { tool: 'set_lineup', args: { teamId: 'team-3', moves: [{ playerId: 'qb1', slot: 'QB' }] } }
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
      expect(await s.savedLineups('team-3')).toEqual([]);
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
