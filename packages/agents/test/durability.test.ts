import { createDynamoRepos, createInMemoryRepos, type Repos } from '@fantasy/server';
import { startLocalTable, type LocalTable } from '@fantasy/server/local';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DISPATCH_ATTEMPTS, DISPATCH_GRACE_MS } from '../src/dispatch.js';
import { AgentActionRequestedSchema, type AgentActionRequested, type BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import type { ModelClient } from '../src/model.js';
import { recoverAgentTasks } from '../src/recovery.js';
import { routeEvent, taskIdFor, triggerKinds } from '../src/router.js';
import { TASK_ATTEMPTS, TASK_LOCK_MS, runAgentAction, taskRetryDelayMs } from '../src/runner.js';
import { lineupTask } from '../src/tasks/lineup.js';
import { noopTask } from '../src/tasks/noop.js';
import {
  BaseDecisionSchema,
  createTaskKindRegistry,
  defineTaskKind,
  type TaskKind
} from '../src/tasks/kinds.js';
import { AGENT_TEAM, LEAGUE_ID, setup, type Setup } from './support.js';

/**
 * Durable dispatch, follow-ups, and task recovery (#207), end to end through the router, the
 * runner, and the recovery sweep, against both repository backends: the in-memory one the sim and
 * unit tests use, and DynamoDB Local (conditional writes and transactions for real).
 */

const PRO = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const AGENT_ID = `${LEAGUE_ID}.${AGENT_TEAM}`;

const tables: LocalTable[] = [];
afterEach(async () => {
  await Promise.all(tables.splice(0).map((t) => t.close()));
});

const backends: [string, () => Promise<Repos>][] = [
  ['in-memory', async () => createInMemoryRepos()],
  [
    'DynamoDB Local',
    async () => {
      const table = await startLocalTable('AgentsDurability');
      tables.push(table);
      return createDynamoRepos(table);
    }
  ]
];

/** Every trigger kind registered as a no-op, so routing can be driven end to end. */
const allKinds = createTaskKindRegistry(triggerKinds().map((kind): TaskKind => ({ ...noopTask, kind })));

function event(detailType: string, detail: Record<string, unknown>, id = 'evt-1'): BusEvent {
  return { id, 'detail-type': detailType, source: 'fantasy', detail };
}

function lineupRequest(overrides: Partial<AgentActionRequested> = {}): AgentActionRequested {
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

/** A publisher that fails on the calls `failing` picks (1-based count of publishes). */
function failPublishes(s: Setup, failing: (n: number, detailType: string) => boolean): () => void {
  const original = s.services.events.publish.bind(s.services.events);
  let n = 0;
  s.services.events.publish = async (detailType, detail) => {
    n++;
    if (failing(n, detailType)) throw Object.assign(new Error('bus down'), { name: 'ServiceUnavailable' });
    return original(detailType, detail);
  };
  return () => {
    s.services.events.publish = original;
  };
}

const requested = (s: Setup) =>
  s.events.events
    .filter((e) => e.detailType === 'Agent Action Requested')
    .map((e) => AgentActionRequestedSchema.parse(e.detail));

/** Runs every sweep-published task not yet run, like the task Lambda would. */
async function runPublished(
  s: Setup,
  model: ModelClient,
  from: number,
  kinds?: ReturnType<typeof createTaskKindRegistry>
) {
  const out = [];
  for (const r of requested(s).slice(from))
    out.push(await runAgentAction(s.deps(model, kinds === undefined ? {} : { kinds }), r));
  return out;
}

describe.each(backends)('durable agent work (%s)', (_name, makeRepos) => {
  async function seated(): Promise<Setup> {
    const s = await setup({ repos: await makeRepos() });
    await s.seat('team-2', PRO);
    await s.seat('team-3', PRO);
    await s.seat('team-4', PRO);
    return s;
  }

  it('keeps fanning out past a failed publish, and a redelivery sends only what was left', async () => {
    const s = await seated();
    const restore = failPublishes(s, (n) => n === 2);
    const route = () =>
      routeEvent(
        { services: s.services, kinds: allKinds },
        event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 5 })
      );
    const first = await route();
    expect(first.map((d) => [d.teamId, d.decision])).toEqual([
      ['team-2', 'requested'],
      ['team-3', 'reserved'],
      ['team-4', 'requested']
    ]);
    expect(requested(s).map((r) => r.teamId)).toEqual(['team-2', 'team-4']);
    restore();
    // The same event again (EventBridge redelivery): its own once-per key and cooldowns let it
    // through, and only the team that was left gets its task.
    s.clock.advance(60_000);
    const again = await route();
    expect(again.map((d) => [d.teamId, d.decision])).toEqual([
      ['team-2', 'requested'],
      ['team-3', 'requested'],
      ['team-4', 'requested']
    ]);
    expect(requested(s).map((r) => r.teamId)).toEqual(['team-2', 'team-4', 'team-3']);
    expect(new Set(requested(s).map((r) => r.taskId)).size).toBe(3);
    // A different event for the same week is still a repeat.
    const other = await routeEvent(
      { services: s.services, kinds: allKinds },
      event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 5 }, 'evt-2')
    );
    expect(other.map((d) => d.decision)).toEqual(['repeat', 'repeat', 'repeat']);
  });

  it('relays a failed schedule later, at the time fixed when it was reserved', async () => {
    const s = await seated();
    const scheduleAt = s.services.events.scheduleAt.bind(s.services.events);
    s.services.events.scheduleAt = async () => {
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    };
    const kickoff = event('Draft Completed', {
      leagueId: LEAGUE_ID,
      week: 1,
      completedAt: '2026-09-01T00:00:00Z'
    });
    const decisions = await routeEvent({ services: s.services, kinds: allKinds }, kickoff);
    expect(decisions.map((d) => d.decision)).toEqual(['reserved', 'reserved', 'reserved']);
    const reservedAt = s.clock.now().getTime();
    expect(s.logs.some((l) => l.includes('agent task dispatch failed; the relay will retry'))).toBe(true);
    // Nothing sealed or payload-shaped reaches the log line: ids and the error's name only.
    expect(s.logs.find((l) => l.includes('dispatch failed'))).not.toContain('completedAt');

    s.services.events.scheduleAt = scheduleAt;
    s.clock.advance(10 * 60_000);
    const report = await recoverAgentTasks(s.services);
    expect(report).toMatchObject({ dispatches: 3, sent: 3, failed: 0 });
    const scheduled = s.events.events.filter((e) => e.detailType === 'Schedule Event');
    expect(scheduled).toHaveLength(3);
    const delays = decisions.map((d) => ('delayMs' in d ? d.delayMs : -1));
    const times = (list: number[]) => [...list].sort((x, y) => x - y);
    expect(times(scheduled.map((e) => Date.parse(String(e.detail.at))))).toEqual(
      times(delays.map((ms) => reservedAt + ms))
    );
    // A redelivered trigger neither moves nor doubles them.
    const again = await routeEvent({ services: s.services, kinds: allKinds }, kickoff);
    expect(again.map((d) => d.decision)).toEqual(['requested', 'requested', 'requested']);
    expect(s.events.events.filter((e) => e.detailType === 'Schedule Event')).toHaveLength(3);
    expect(await recoverAgentTasks(s.services)).toMatchObject({ dispatches: 0 });
  });

  it('lets racing deliveries through each gate exactly once', async () => {
    const s = await seated();
    const route = (e: BusEvent) => routeEvent({ services: s.services, kinds: allKinds }, e);
    // One event delivered twice at once: every team gets exactly one task.
    const e = event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 5 });
    const [a, b] = await Promise.all([route(e), route(e)]);
    expect([...(a ?? []), ...(b ?? [])].every((d) => d.decision === 'requested')).toBe(true);
    const tasks = new Set(requested(s).map((r) => r.taskId));
    expect(tasks.size).toBe(3);
    // Two events racing for one once-per key (after the cooldowns): one fans out, the other repeats.
    s.clock.advance(24 * 60 * 60_000);
    const [x, y] = await Promise.all([
      route(event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 6 }, 'evt-x')),
      route(event('Waiver Window Opened', { leagueId: LEAGUE_ID, week: 6 }, 'evt-y'))
    ]);
    expect([x, y].map((ds) => (ds ?? []).map((d) => d.decision).join())).toEqual(
      expect.arrayContaining(['requested,requested,requested', 'repeat,repeat,repeat'])
    );
    // Two news alerts racing for one agent's lineup cooldown: one task, one cooldown.
    const news = (id: string) =>
      route(
        event(
          'Player Status Changed',
          { playerId: 'p1', rosteredBy: [{ leagueId: LEAGUE_ID, teamId: 'team-2' }] },
          id
        )
      );
    const raced = (await Promise.all([news('evt-n1'), news('evt-n2')])).flat().map((d) => d.decision);
    expect(raced.sort()).toEqual(['cooldown', 'requested']);
    // And racing runs of one task: one runs it, the other sees it running or done.
    const run = requested(s).at(-1) as AgentActionRequested;
    const model = new ScriptedModelClient();
    const runs = await Promise.all([
      runAgentAction(s.deps(model, { kinds: allKinds }), run),
      runAgentAction(s.deps(model, { kinds: allKinds }), run)
    ]);
    expect(runs.map((r) => r.status)).toContain('completed');
    expect(model.transcript).toHaveLength(1);
    expect((await s.repos.agents.listTasks(LEAGUE_ID)).filter((t) => t.taskId === run.taskId)).toHaveLength(
      1
    );
  });

  it('recovers a crash after a mutation without replaying the model', async () => {
    const s = await seated();
    const model = new ScriptedModelClient();
    // The run acts (set_lineup), then its process dies before it can checkpoint.
    const agents = s.repos.agents;
    const save = agents.saveTaskPending.bind(agents);
    agents.saveTaskPending = async () => {
      throw new Error('process died');
    };
    await expect(runAgentAction(s.deps(model), lineupRequest())).rejects.toThrow('process died');
    agents.saveTaskPending = save;
    expect(await s.savedLineups()).toHaveLength(1);
    expect(await agents.listTasks(LEAGUE_ID)).toEqual([]);
    expect(model.transcript).toHaveLength(1);

    // A redelivery inside the lease leaves it to the (dead) worker; nothing is recovered yet.
    expect(await runAgentAction(s.deps(model), lineupRequest())).toMatchObject({
      fallbackReason: 'in_progress'
    });
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 0 });

    // Once the lease runs out, the sweep delivers it again, without any other event.
    s.clock.advance(TASK_LOCK_MS);
    const before = requested(s).length;
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 1, redelivered: 1 });
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 0 });
    const [record] = await runPublished(s, model, before);
    // The earlier attempt acted, so the model is not asked again: the deterministic fallback
    // reconciles from the lineup as it is now.
    expect(record).toMatchObject({ status: 'fallback', fallbackReason: 'recovered', attempts: 2 });
    expect(model.transcript).toHaveLength(1);
    expect(await agents.listTasks(LEAGUE_ID)).toEqual([record]);
    expect(s.logs.some((l) => l.includes('agent task recovering after partial effects'))).toBe(true);
  });

  it('fences a stalled worker off once its lease is taken over', async () => {
    const s = await seated();
    const scripted = new ScriptedModelClient();
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const model: ModelClient = {
      name: 'stalling',
      run: async (request) => {
        if (++calls === 1) await stalled;
        return scripted.run(request);
      }
    };
    const deps = s.deps(model, { modelTimeoutMs: 600_000 });
    const first = runAgentAction(deps, lineupRequest());
    // The worker stalls in its model call past its lease; the sweep hands the task to another.
    await new Promise((r) => setTimeout(r, 50));
    s.clock.advance(TASK_LOCK_MS + 1);
    const before = requested(s).length;
    expect(await recoverAgentTasks(s.services)).toMatchObject({ redelivered: 1 });
    const [second] = await runPublished(s, model, before);
    expect(second).toMatchObject({ status: 'completed', finalAction: 'set_lineup', attempts: 2 });
    // The stalled worker wakes up: its set_lineup is refused and nothing it has overwrites the record.
    release();
    const stale = await first;
    expect(stale.toolsCalled).toContainEqual(
      expect.objectContaining({ name: 'set_lineup', ok: false, errorCode: 'CONFLICT' })
    );
    expect(await s.repos.agents.listTasks(LEAGUE_ID)).toEqual([second]);
    expect(s.logs.some((l) => l.includes('a newer attempt holds the task'))).toBe(true);
    // Its spend still counts; only the finishing attempt counts as a task.
    const usage = await s.repos.agents.weekUsage(LEAGUE_ID, 5);
    expect(usage.reduce((n, u) => n + u.tasks, 0)).toBe(1);
    expect(usage.reduce((n, u) => n + u.inputTokens, 0)).toBeGreaterThan(second?.usage[0]?.inputTokens ?? 0);
  });

  it('delivers follow-ups once, and finishes from its checkpoint without acting again', async () => {
    const s = await seated();
    let applied = 0;
    const kickoff = defineTaskKind({
      kind: 'kickoff',
      title: 'Kick off',
      modelRole: 'decision',
      payload: z.object({}),
      decision: BaseDecisionSchema,
      prepare: async () => null,
      instructions: () => 'Kick off.',
      apply: async () => {
        applied++;
        return {
          action: 'kicked_off',
          summary: 'Kicked off.',
          followUps: [{ kind: 'noop', payload: { note: 'next' } }]
        };
      },
      fallback: async () => ({ action: 'none', summary: 'ok' })
    });
    const kinds = createTaskKindRegistry([kickoff, noopTask]);
    const model = new ScriptedModelClient({ script: () => ({ steps: [], decision: { summary: 'Go.' } }) });
    const parent = lineupRequest({ taskId: 'kickoff.evt1', kind: 'kickoff', payload: {} });

    // Reserving the follow-up fails once: the parent's action is checkpointed, and it is retried.
    const agents = s.repos.agents;
    const reserve = agents.reserveDispatch.bind(agents);
    agents.reserveDispatch = async () => {
      throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    };
    const first = await runAgentAction(s.deps(model, { kinds }), parent);
    agents.reserveDispatch = reserve;
    expect(first).toMatchObject({ status: 'skipped', fallbackReason: 'retry_scheduled' });
    expect(await agents.listTasks(LEAGUE_ID)).toEqual([]);

    s.clock.advance(taskRetryDelayMs(1));
    const before = requested(s).length;
    expect(await recoverAgentTasks(s.services)).toMatchObject({ redelivered: 1 });
    const [done] = await runPublished(s, model, before, kinds);
    expect(done).toMatchObject({ status: 'completed', finalAction: 'kicked_off', attempts: 2 });
    expect(applied).toBe(1);
    expect(model.transcript).toHaveLength(1);
    expect(s.logs.some((l) => l.includes('agent task finishing from its checkpoint'))).toBe(true);

    // The follow-up went out once; delivering it twice (at once, and again later) runs it once.
    const followUpId = taskIdFor('evt-1', AGENT_TEAM, 'noop');
    const followUps = requested(s).filter((r) => r.taskId === followUpId);
    expect(followUps).toHaveLength(1);
    const followUp = followUps[0] as AgentActionRequested;
    const runs = await Promise.all([
      runAgentAction(s.deps(model, { kinds }), followUp),
      runAgentAction(s.deps(model, { kinds }), followUp)
    ]);
    const later = await runAgentAction(s.deps(model, { kinds }), followUp);
    expect(later).toEqual((await agents.listTasks(LEAGUE_ID)).find((t) => t.taskId === followUpId));
    expect(runs.map((r) => r.status)).toContain('completed');
    expect(model.transcript).toHaveLength(2);
    // Replaying the parent requests nothing more.
    await runAgentAction(s.deps(model, { kinds }), parent);
    expect(requested(s).filter((r) => r.taskId === followUpId)).toHaveLength(1);
  });

  it('retries a retryable failure on a schedule, then records the exhaustion', async () => {
    const s = await seated();
    const flaky = defineTaskKind({
      kind: 'flaky',
      title: 'Flaky',
      modelRole: 'decision',
      payload: z.object({}),
      decision: BaseDecisionSchema,
      prepare: async () => {
        throw Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' });
      },
      instructions: () => '',
      apply: async () => ({ action: 'none', summary: 'ok' }),
      fallback: async () => ({ action: 'none', summary: 'ok' })
    });
    const kinds = createTaskKindRegistry([flaky]);
    const model = new ScriptedModelClient();
    const request = lineupRequest({ taskId: 'flaky.evt1', kind: 'flaky', payload: {} });
    const first = await runAgentAction(s.deps(model, { kinds }), request);
    expect(first).toMatchObject({ status: 'skipped', fallbackReason: 'retry_scheduled' });
    // Not before its retry time.
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 0 });
    let last = first;
    for (let attempt = 1; attempt <= TASK_ATTEMPTS; attempt++) {
      s.clock.advance(taskRetryDelayMs(attempt));
      const before = requested(s).length;
      expect(await recoverAgentTasks(s.services)).toMatchObject({ redelivered: 1 });
      [last] = (await runPublished(s, model, before, kinds)) as [typeof first];
    }
    expect(last).toMatchObject({
      status: 'failed',
      fallbackReason: 'retries_exhausted',
      attempts: TASK_ATTEMPTS + 1
    });
    expect(await s.repos.agents.listTasks(LEAGUE_ID)).toEqual([last]);
    expect(s.logs.some((l) => l.includes('agent task gave up'))).toBe(true);
  });

  it('abandons a dispatch after every send failed, with a failed record in the activity log', async () => {
    const s = await seated();
    failPublishes(s, (_n, type) => type === 'Agent Action Requested');
    const decisions = await routeEvent(
      { services: s.services, kinds: allKinds },
      event('Player Status Changed', {
        playerId: 'p1',
        rosteredBy: [{ leagueId: LEAGUE_ID, teamId: 'team-2' }]
      })
    );
    expect(decisions.map((d) => d.decision)).toEqual(['reserved']);
    s.clock.advance(DISPATCH_GRACE_MS);
    let abandoned = 0;
    for (let sweep = 0; sweep < DISPATCH_ATTEMPTS + 2 && abandoned === 0; sweep++) {
      s.clock.advance(60 * 60_000);
      abandoned = (await recoverAgentTasks(s.services)).abandoned;
    }
    expect(abandoned).toBe(1);
    const [record] = await s.repos.agents.listTasks(LEAGUE_ID);
    expect(record).toMatchObject({
      status: 'failed',
      fallbackReason: 'dispatch_exhausted',
      kind: 'lineup',
      week: 5
    });
    expect(await s.repos.agents.getDispatch(record?.taskId ?? '')).toMatchObject({ state: 'abandoned' });
    // A redelivered trigger reports it rather than sending it again.
    const again = await routeEvent(
      { services: s.services, kinds: allKinds },
      event('Player Status Changed', {
        playerId: 'p1',
        rosteredBy: [{ leagueId: LEAGUE_ID, teamId: 'team-2' }]
      })
    );
    expect(again.map((d) => d.decision)).toEqual(['abandoned']);
  });
});

describe('recovery edges', () => {
  it('marks an exhausted dispatch sent when its task did reach a runner', async () => {
    const s = await setup();
    await s.seat(AGENT_TEAM, PRO);
    const request = lineupRequest();
    const now = s.clock.now();
    await s.repos.agents.reserveDispatch({
      taskId: request.taskId,
      leagueId: LEAGUE_ID,
      request,
      at: null,
      delayMs: 0,
      state: 'reserved',
      attempts: DISPATCH_ATTEMPTS,
      reservedAt: now.toISOString(),
      retryAt: now.toISOString()
    });
    await runAgentAction(
      s.deps(new ScriptedModelClient(), { kinds: createTaskKindRegistry([lineupTask]) }),
      request
    );
    expect(await recoverAgentTasks(s.services)).toMatchObject({ abandoned: 1 });
    expect(await s.repos.agents.getDispatch(request.taskId)).toMatchObject({ state: 'dispatched' });
    expect((await s.repos.agents.listTasks(LEAGUE_ID)).map((t) => t.status)).toEqual(['completed']);
  });

  it('lets one of two racing sweeps deliver an expired lease, and abandons work for a league that is gone', async () => {
    const s = await setup();
    await s.repos.agents.claimTask({
      taskId: 'stuck',
      now: s.clock.now(),
      lockUntil: s.clock.now(),
      request: lineupRequest({ taskId: 'stuck' })
    });
    const sweeps = await Promise.all([recoverAgentTasks(s.services), recoverAgentTasks(s.services)]);
    expect(sweeps.map((r) => r.redelivered).sort()).toEqual([0, 1]);

    const gone = lineupRequest({ taskId: 'gone.1', leagueId: 'gone' });
    const now = s.clock.now().toISOString();
    await s.repos.agents.reserveDispatch({
      taskId: gone.taskId,
      leagueId: 'gone',
      request: gone,
      at: null,
      delayMs: 0,
      state: 'reserved',
      attempts: DISPATCH_ATTEMPTS,
      reservedAt: now,
      retryAt: now
    });
    expect(await recoverAgentTasks(s.services)).toMatchObject({ abandoned: 1 });
    expect(await s.repos.agents.listTasks('gone')).toEqual([
      expect.objectContaining({ status: 'failed', fallbackReason: 'dispatch_exhausted', week: 0 })
    ]);
  });

  it('sets aside a lease it cannot deliver again, and retries a failed redelivery', async () => {
    const s = await setup();
    // A claim from before #207 has no stored request.
    await s.repos.agents.claimTask({ taskId: 'old', now: s.clock.now(), lockUntil: s.clock.now() });
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 1, redelivered: 0 });
    expect(s.logs.some((l) => l.includes('cannot be recovered'))).toBe(true);
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 0 });

    await s.repos.agents.claimTask({
      taskId: 'lost',
      now: s.clock.now(),
      lockUntil: s.clock.now(),
      request: lineupRequest({ taskId: 'lost' })
    });
    const restore = failPublishes(s, () => true);
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 1, redelivered: 0 });
    restore();
    // Held for one lease, then delivered.
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 0 });
    s.clock.advance(TASK_LOCK_MS);
    expect(await recoverAgentTasks(s.services)).toMatchObject({ leases: 1, redelivered: 1 });
  });
});
