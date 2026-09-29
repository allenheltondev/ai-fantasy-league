import { ApiError } from '@fantasy/server';
import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { dispatchBackoffMs, dispatchTask, errorName } from '../src/dispatch.js';
import type { AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { recoverAgentTasks } from '../src/recovery.js';
import { failureClass, runAgentAction, taskRetryDelayMs } from '../src/runner.js';
import {
  BaseDecisionSchema,
  createTaskKindRegistry,
  defineTaskKind,
  type TaskContext,
  type TaskOutcome
} from '../src/tasks/kinds.js';
import { AGENT_TEAM, LEAGUE_ID, setup } from './support.js';

/** The task lifecycle's failure paths (#207): what is retried, recorded, or discarded. */

const PRO = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;

function request(kind: string): AgentActionRequested {
  return {
    taskId: `${kind}.evt1`,
    leagueId: LEAGUE_ID,
    teamId: AGENT_TEAM,
    agentId: `${LEAGUE_ID}.${AGENT_TEAM}`,
    kind,
    trigger: { detailType: 'Lineup Lock Approaching', eventId: 'evt-1', urgent: true },
    payload: {},
    requestedAt: '2026-10-04T15:00:00.000Z'
  };
}

const throttled = () => Object.assign(new Error('slow down'), { name: 'ThrottlingException' });

/** One mutation through the task's own tools (it reaches set_lineup, whatever it answers). */
const act = (ctx: TaskContext) => ctx.tools.call('set_lineup', { teamId: AGENT_TEAM, week: 5, moves: [] });

function kind(parts: {
  apply?: (ctx: TaskContext) => Promise<TaskOutcome>;
  fallback?: (ctx: TaskContext) => Promise<TaskOutcome>;
}) {
  return createTaskKindRegistry([
    defineTaskKind({
      kind: 'probe',
      title: 'Probe',
      modelRole: 'decision',
      payload: z.object({}),
      decision: BaseDecisionSchema,
      prepare: async () => null,
      instructions: () => 'Probe.',
      apply: (ctx) => parts.apply?.(ctx) ?? Promise.resolve({ action: 'none', summary: 'ok' }),
      fallback: (ctx) => parts.fallback?.(ctx) ?? Promise.resolve({ action: 'none', summary: 'fallback ok' })
    })
  ]);
}

async function seated() {
  const s = await setup();
  await s.seat(AGENT_TEAM, PRO);
  return s;
}

describe('failure classes', () => {
  it('retries what may pass and records what will fail the same way', () => {
    expect(failureClass(throttled())).toBe('retryable');
    expect(failureClass(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('retryable');
    expect(failureClass(Object.assign(new Error('x'), { $retryable: { throttling: false } }))).toBe(
      'retryable'
    );
    expect(failureClass(new ApiError('CONFLICT', 'changed', { fix: 'retry' }))).toBe('retryable');
    expect(failureClass(new ApiError('INVALID_INPUT', 'bad', { fix: 'fix it' }))).toBe('permanent');
    expect(failureClass(new ZodError([]))).toBe('permanent');
    expect(failureClass(new TypeError('bug'))).toBe('permanent');
    expect(failureClass('a string')).toBe('permanent');
  });

  it('names errors without their messages, and backs off', () => {
    expect(errorName(new Error('Bid of $41 on Puka'))).toBe('Error');
    expect(errorName(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
    expect(errorName('boom')).toBe('string');
    expect([1, 2, 3].map(taskRetryDelayMs)).toEqual([60_000, 120_000, 240_000]);
    expect([1, 2, 9, 20].map(dispatchBackoffMs)).toEqual([30_000, 60_000, 3_600_000, 3_600_000]);
  });
});

describe('dispatchTask', () => {
  it('sends a task once, and reports an earlier dispatch instead of sending it again', async () => {
    const s = await seated();
    const task = request('probe');
    expect(await dispatchTask(s.services, task, { delayMs: 0 })).toEqual({
      status: 'dispatched',
      delayMs: 0
    });
    expect(await dispatchTask(s.services, task)).toEqual({ status: 'dispatched', delayMs: 0 });
    // Scheduled for now (a delay of 0 was asked for), once.
    expect(s.events.events.map((e) => e.detailType)).toEqual(['Schedule Event']);
    await s.repos.agents.settleDispatch(task.taskId, 'abandoned');
    expect(await dispatchTask(s.services, task)).toEqual({ status: 'abandoned', delayMs: 0 });
  });
});

describe('task lifecycle failures', () => {
  it('retries a decision that failed after acting, and reconciles instead of replaying it', async () => {
    const s = await seated();
    let applies = 0;
    const kinds = kind({
      apply: async (ctx) => {
        applies++;
        await act(ctx);
        throw new Error('bug after acting');
      }
    });
    const model = new ScriptedModelClient({ script: () => ({ steps: [], decision: { summary: 'Go.' } }) });
    const first = await runAgentAction(s.deps(model, { kinds }), request('probe'));
    expect(first).toMatchObject({ status: 'skipped', fallbackReason: 'retry_scheduled' });
    // Its model spend counts now, as no task yet.
    expect((await s.repos.agents.weekUsage(LEAGUE_ID, 5))[0]).toMatchObject({ tasks: 0 });
    s.clock.advance(taskRetryDelayMs(1));
    await recoverAgentTasks(s.services);
    const again = await runAgentAction(s.deps(model, { kinds }), request('probe'));
    expect(again).toMatchObject({
      status: 'fallback',
      fallbackReason: 'recovered',
      reasoningSummary: 'fallback ok'
    });
    expect(applies).toBe(1);
    expect(model.transcript).toHaveLength(1);
  });

  it('retries a fallback that hit a retryable failure', async () => {
    const s = await seated();
    const kinds = kind({
      fallback: async () => {
        throw throttled();
      }
    });
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient(), { kinds, killSwitch: { engaged: async () => true } }),
      request('probe')
    );
    expect(record).toMatchObject({ status: 'skipped', fallbackReason: 'retry_scheduled' });
    expect(
      await s.repos.agents.listExpiredTaskLeases(new Date(Date.parse(record.startedAt) + 60_000), 5)
    ).toEqual([expect.objectContaining({ taskId: 'probe.evt1', attempt: 1 })]);
  });

  it('discards what a fenced-off attempt produced, however it ends', async () => {
    for (const parts of [
      // Its decision throws after a refused mutation.
      {
        apply: async (ctx: TaskContext) => {
          await act(ctx);
          throw new Error('confused');
        }
      },
      // Its fallback throws after a refused mutation.
      {
        fallback: async (ctx: TaskContext) => {
          await act(ctx);
          throw new Error('confused');
        }
      }
    ]) {
      const s = await seated();
      // A newer attempt holds the task: every effect this one tries is refused.
      s.repos.agents.recordTaskEffect = async () => false;
      const record = await runAgentAction(
        s.deps(new ScriptedModelClient({ script: () => ({ steps: [], decision: { summary: 'Go.' } }) }), {
          kinds: kind(parts),
          killSwitch: { engaged: async () => parts.fallback !== undefined }
        }),
        request('probe')
      );
      expect(record.toolsCalled).toContainEqual(
        expect.objectContaining({ ok: false, errorCode: 'CONFLICT' })
      );
      expect(await s.repos.agents.listTasks(LEAGUE_ID)).toEqual([]);
      expect(s.logs.some((l) => l.includes('a newer attempt holds the task'))).toBe(true);
    }
  });

  it('discards its record when a newer attempt took over just before it finished', async () => {
    const s = await seated();
    s.repos.agents.completeTask = async () => false;
    const record = await runAgentAction(
      s.deps(new ScriptedModelClient(), { kinds: kind({}) }),
      request('probe')
    );
    expect(record.status).toBe('completed');
    expect(s.logs.some((l) => l.includes('a newer attempt holds the task'))).toBe(true);
  });
});
