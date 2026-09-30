import {
  createDynamoRepos,
  createInMemoryRepos,
  leagueBudget,
  roundUsd,
  usageKey,
  type AgentUsageEntry,
  type BudgetHold,
  type League,
  type Repos
} from '@fantasy/server';
import { startLocalTable, type LocalTable } from '@fantasy/server/local';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentActionRequestedSchema, type AgentActionRequested } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { withRunUsage, type ModelClient } from '../src/model.js';
import { recoverAgentTasks } from '../src/recovery.js';
import { TASK_LOCK_MS, runAgentAction, taskRetryDelayMs } from '../src/runner.js';
import { lineupTask } from '../src/tasks/lineup.js';
import { BaseDecisionSchema, createTaskKindRegistry, defineTaskKind } from '../src/tasks/kinds.js';
import { AGENT_TEAM, LEAGUE_ID, setup, type Setup } from './support.js';

/**
 * Spend accounting (#209) through the runner and the recovery sweep, against both repository
 * backends: admission holds each model call's estimate against the weekly ceiling atomically, the
 * usage ledger charges every call and every finished task once, and holds left by a dead worker are
 * settled by the sweep.
 */

const PRO = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const WEEK = 5;

const tables: LocalTable[] = [];
afterEach(async () => {
  await Promise.all(tables.splice(0).map((t) => t.close()));
});

const backends: [string, () => Promise<Repos>][] = [
  ['in-memory', async () => createInMemoryRepos()],
  [
    'DynamoDB Local',
    async () => {
      const table = await startLocalTable('AgentsBudget');
      tables.push(table);
      return createDynamoRepos(table);
    }
  ]
];

/** A decision kind with no league effects: `decided` by the model, `fallback_ran` without it. */
let applyFailures = 0;
const probe = defineTaskKind({
  kind: 'probe',
  title: 'Probe',
  modelRole: 'decision',
  payload: z.object({}),
  decision: BaseDecisionSchema,
  prepare: async () => null,
  instructions: () => 'Decide.',
  apply: async () => {
    if (applyFailures > 0) {
      applyFailures--;
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    }
    return { action: 'decided', summary: 'Decided.' };
  },
  fallback: async () => ({ action: 'fallback_ran', summary: 'The deterministic fallback decided.' })
});
const kinds = createTaskKindRegistry([probe, lineupTask]);

function task(teamId = AGENT_TEAM, eventId = 'evt-1', kind = 'probe'): AgentActionRequested {
  return {
    taskId: `${kind}.${eventId}.${teamId}`,
    leagueId: LEAGUE_ID,
    teamId,
    agentId: `${LEAGUE_ID}.${teamId}`,
    kind,
    trigger: { detailType: 'Lineup Lock Approaching', eventId, urgent: true },
    payload: kind === 'lineup' ? { reason: 'lock', week: WEEK } : {},
    requestedAt: '2026-10-04T15:00:00.000Z'
  };
}

const model = () => new ScriptedModelClient({ script: () => ({ steps: [], decision: { summary: 'Go.' } }) });

async function totals(s: Setup) {
  const rows = await s.repos.agents.weekUsage(LEAGUE_ID, WEEK);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    costUsd: roundUsd(sum((r) => r.costUsd)),
    tasks: sum((r) => r.tasks)
  };
}

/** Holds still kept, whenever they lapse. */
const held = (s: Setup) => s.repos.agents.listStaleHolds(new Date('2100-01-01T00:00:00Z'), 100);

async function budget(s: Setup) {
  return leagueBudget(s.repos.agents, (await s.repos.leagues.get(LEAGUE_ID)) as League);
}

/**
 * Records every hold asked for, and lets each batch of `size` admissions through at once;
 * `admitted()` resolves once the whole batch has its answers.
 */
function watchHolds(s: Setup) {
  const agents = s.repos.agents;
  const reserve = agents.reserveBudget.bind(agents);
  const holds: BudgetHold[] = [];
  let size = 1;
  let waiting: (() => void)[] = [];
  let answered = 0;
  const batchDone: (() => void)[] = [];
  agents.reserveBudget = async (hold, ceilingUsd) => {
    holds.push(hold);
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= size) {
        for (const go of waiting) go();
        waiting = [];
      }
    });
    const admission = await reserve(hold, ceilingUsd);
    answered++;
    if (answered >= size) for (const go of batchDone.splice(0)) go();
    return admission;
  };
  return {
    holds,
    batch(n: number) {
      size = n;
      answered = 0;
    },
    admitted: () => new Promise<void>((resolve) => (answered >= size ? resolve() : batchDone.push(resolve)))
  };
}

/** Makes the ledger write for keys `failing` picks throw, once each. */
function failLedger(s: Setup, failing: (entry: AgentUsageEntry) => boolean) {
  const agents = s.repos.agents;
  const record = agents.recordUsage.bind(agents);
  const failed = new Set<string>();
  agents.recordUsage = async (entry, hold) => {
    if (failing(entry) && !failed.has(entry.key)) {
      failed.add(entry.key);
      throw Object.assign(new Error('dynamo down'), { name: 'ServiceUnavailable' });
    }
    return record(entry, hold);
  };
  return () => {
    agents.recordUsage = record;
  };
}

describe.each(backends)('agent spend accounting (%s)', (_name, makeRepos) => {
  async function seated(): Promise<Setup> {
    applyFailures = 0;
    const s = await setup({ repos: await makeRepos() });
    await s.seat('team-2', PRO);
    await s.seat('team-3', PRO);
    await s.seat('team-4', PRO);
    return s;
  }

  it('admits racing tasks near the ceiling only as far as the room goes; the rest fall back', async () => {
    const s = await seated();
    const watch = watchHolds(s);
    const scripted = model();
    const deps = s.deps(scripted, { kinds });
    // One task alone, to learn what a call holds.
    expect(await runAgentAction(deps, task('team-2', 'evt-0'))).toMatchObject({ status: 'completed' });
    const hold = watch.holds[0] as BudgetHold;
    expect(hold).toMatchObject({ modelKey: 'kimi-k2-thinking', key: usageKey(1, 1), outputTokens: 6144 });
    expect(hold.costUsd).toBeGreaterThan(0);

    // Room for one and a half calls, and three tasks asking at the same moment.
    const { ceilingUsd, spentUsd } = await budget(s);
    await s.repos.agents.addUsage({
      leagueId: LEAGUE_ID,
      week: WEEK,
      agentId: 'someone-else',
      modelKey: 'nova-pro',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: roundUsd(ceilingUsd - spentUsd - 1.5 * hold.costUsd),
      tasks: 0
    });
    watch.batch(3);
    // The admitted call runs only once every admission is answered: they are truly simultaneous.
    const racing: ModelClient = {
      name: 'racing',
      run: async (request) => {
        await watch.admitted();
        return scripted.run(request);
      }
    };
    const records = await Promise.all(
      ['team-2', 'team-3', 'team-4'].map((t) => runAgentAction(s.deps(racing, { kinds }), task(t)))
    );
    expect(records.filter((r) => r.status === 'completed')).toHaveLength(1);
    // The others never reach the model: the deterministic fallback decides for them.
    const refused = records.filter((r) => r.status !== 'completed');
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r).toMatchObject({
        status: 'fallback',
        fallbackReason: 'budget_reserved',
        finalAction: 'fallback_ran'
      });
      expect(r.usage).toEqual([]);
    }
    expect(scripted.transcript).toHaveLength(2);
    expect(s.logs.some((l) => l.includes('agent model call not admitted'))).toBe(true);
    // Nothing is left held, and the week stayed within its ceiling.
    expect(await held(s)).toEqual([]);
    expect((await budget(s)).spentUsd).toBeLessThanOrEqual(ceilingUsd);

    // With recorded spend alone leaving no room for a call, it is refused as over budget (though
    // the week has not reached its ceiling, so no one is told the agents are on autopilot).
    await s.repos.agents.addUsage({
      leagueId: LEAGUE_ID,
      week: WEEK,
      agentId: 'someone-else',
      modelKey: 'nova-pro',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: roundUsd((await budget(s)).remainingUsd - hold.costUsd / 2),
      tasks: 0
    });
    watch.batch(1);
    const over = await runAgentAction(deps, task('team-2', 'evt-2'));
    expect(over).toMatchObject({
      status: 'fallback',
      fallbackReason: 'budget_exceeded',
      finalAction: 'fallback_ran'
    });
    expect(s.events.events.some((e) => e.detailType === 'Agent Budget Exceeded')).toBe(false);
  });

  it('repairs a usage write that failed after completion, and never counts a line twice', async () => {
    const s = await seated();
    const restore = failLedger(s, (e) => e.tasks > 0);
    const deps = s.deps(model(), { kinds });
    // The task is recorded, then counting it fails: the delivery fails, as the Lambda would.
    await expect(runAgentAction(deps, task())).rejects.toThrow('dynamo down');
    restore();
    const [stored] = await s.repos.agents.listTasks(LEAGUE_ID);
    expect(stored).toMatchObject({ status: 'completed', finalAction: 'decided' });
    const line = stored?.usage[0];
    expect(line).toMatchObject({ attempt: 1, call: 1 });
    // The call itself was charged when it ended; only the task's count is missing.
    const before = await totals(s);
    expect(before).toMatchObject({ costUsd: stored?.costUsd, tasks: 0 });

    // The redelivery replays the record and repairs the count.
    expect(await runAgentAction(deps, task())).toEqual(stored);
    const after = await totals(s);
    expect(after).toEqual({ ...before, tasks: 1 });
    // Duplicate reconciliation: replays at once, and the same ledger line again, change nothing.
    await Promise.all([runAgentAction(deps, task()), runAgentAction(deps, task())]);
    const again = {
      leagueId: LEAGUE_ID,
      week: WEEK,
      agentId: `${LEAGUE_ID}.${AGENT_TEAM}`,
      taskId: task().taskId,
      key: usageKey(1, 1),
      modelKey: line?.modelKey ?? '',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
      tasks: 0,
      estimated: false,
      at: s.clock.now().toISOString()
    };
    expect(await s.repos.agents.recordUsage(again)).toBe(false);
    expect(await totals(s)).toEqual(after);
    expect(await held(s)).toEqual([]);
  });

  it('charges a call whose own usage write failed when the attempt ends', async () => {
    const s = await seated();
    const restore = failLedger(s, (e) => e.key === usageKey(1, 1));
    const record = await runAgentAction(s.deps(model(), { kinds }), task());
    restore();
    expect(record).toMatchObject({ status: 'completed' });
    expect(s.logs.some((l) => l.includes('agent usage write failed; retried when the attempt ends'))).toBe(
      true
    );
    expect(await totals(s)).toMatchObject({ costUsd: record.costUsd, tasks: 1 });
    expect(await held(s)).toEqual([]);
  });

  it('keeps every model attempt: down the chain, a failed multi-turn run, and a retried delivery', async () => {
    const s = await seated();
    const scripted = model();
    // The first model spends 5,000 tokens over a few turns, then is throttled: the next one decides.
    const chain: ModelClient = {
      name: 'chain',
      run: async (request) => {
        if (request.modelId === 'moonshot.kimi-k2-thinking') {
          const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
          throw withRunUsage(throttled, { inputTokens: 5000, outputTokens: 300, estimated: false });
        }
        return scripted.run(request);
      }
    };
    const record = await runAgentAction(s.deps(chain, { kinds }), task());
    expect(record).toMatchObject({ status: 'completed', finalAction: 'decided' });
    expect(record.usage).toEqual([
      expect.objectContaining({
        modelKey: 'kimi-k2-thinking',
        inputTokens: 5000,
        outputTokens: 300,
        estimatedTokens: false,
        attempt: 1,
        call: 1
      }),
      expect.objectContaining({ modelKey: 'nova-pro', estimatedTokens: true, attempt: 1, call: 2 })
    ]);
    const rows = await s.repos.agents.weekUsage(LEAGUE_ID, WEEK);
    expect(rows.map((r) => [r.modelKey, r.tasks])).toEqual([
      ['kimi-k2-thinking', 1],
      ['nova-pro', 1]
    ]);
    expect(rows.find((r) => r.modelKey === 'kimi-k2-thinking')).toMatchObject({ inputTokens: 5000 });

    // A run that fails after several turns is charged what the provider reported, not the guess.
    const failing: ModelClient = {
      name: 'failing',
      run: async () => {
        throw withRunUsage(new Error('bad answer'), {
          inputTokens: 7000,
          outputTokens: 20,
          estimated: false
        });
      }
    };
    const failed = await runAgentAction(s.deps(failing, { kinds }), task(AGENT_TEAM, 'evt-2'));
    expect(failed).toMatchObject({
      status: 'fallback',
      fallbackReason: 'model_error',
      finalAction: 'fallback_ran'
    });
    expect(failed.usage).toEqual([
      expect.objectContaining({ inputTokens: 7000, outputTokens: 20, estimatedTokens: false })
    ]);

    // A delivery given back after its call: the retry calls again under its own key, and both count.
    const spentBefore = await totals(s);
    applyFailures = 1;
    const deps = s.deps(scripted, { kinds });
    const first = await runAgentAction(deps, task(AGENT_TEAM, 'evt-3'));
    expect(first).toMatchObject({ status: 'skipped', fallbackReason: 'retry_scheduled' });
    s.clock.advance(taskRetryDelayMs(1));
    const before = s.events.events.length;
    expect(await recoverAgentTasks(s.services)).toMatchObject({ redelivered: 1 });
    const redelivered = s.events.events
      .slice(before)
      .filter((e) => e.detailType === 'Agent Action Requested')
      .map((e) => AgentActionRequestedSchema.parse(e.detail));
    const [second] = await Promise.all(redelivered.map((r) => runAgentAction(deps, r)));
    expect(second).toMatchObject({ status: 'completed', attempts: 2 });
    expect(second?.usage).toEqual([expect.objectContaining({ attempt: 2, call: 1 })]);
    const spentAfter = await totals(s);
    const both = [...first.usage, ...(second?.usage ?? [])];
    expect(spentAfter.inputTokens - spentBefore.inputTokens).toBe(
      both.reduce((n, u) => n + u.inputTokens, 0)
    );
    expect(spentAfter.tasks - spentBefore.tasks).toBe(1);
    expect(await held(s)).toEqual([]);
  });

  it('leaves a hold it could not release or settle to a later sweep', async () => {
    const s = await seated();
    const agents = s.repos.agents;
    const release = agents.releaseBudget.bind(agents);
    agents.releaseBudget = async () => {
      throw Object.assign(new Error('dynamo down'), { name: 'ServiceUnavailable' });
    };
    // The first model is unavailable before it ran: its hold should go, but the release fails.
    const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    const scripted = new ScriptedModelClient({
      script: () => ({ steps: [], decision: { summary: 'Go.' } }),
      fail: (id) => (id === 'moonshot.kimi-k2-thinking' ? throttled : undefined)
    });
    const record = await runAgentAction(s.deps(scripted, { kinds }), task());
    agents.releaseBudget = release;
    expect(record).toMatchObject({
      status: 'completed',
      usage: [expect.objectContaining({ modelKey: 'nova-pro' })]
    });
    expect(s.logs.some((l) => l.includes('agent budget hold not released'))).toBe(true);
    const [hold] = await held(s);
    expect(hold).toMatchObject({ modelKey: 'kimi-k2-thinking', key: usageKey(1, 1) });

    // The sweep settles it once the lease is over; a failed write is tried again on the next pass.
    s.clock.advance(TASK_LOCK_MS);
    const restore = failLedger(s, () => true);
    expect(await recoverAgentTasks(s.services)).toMatchObject({ holds: 1, settled: 0 });
    expect(s.logs.some((l) => l.includes('agent budget hold could not be settled; will retry'))).toBe(true);
    restore();
    expect(await recoverAgentTasks(s.services)).toMatchObject({ holds: 1, settled: 1 });
    expect(await held(s)).toEqual([]);
  });

  it('settles a hold its dead worker left behind once, and the late write is a duplicate', async () => {
    const s = await seated();
    const scripted = new ScriptedModelClient();
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stalling: ModelClient = {
      name: 'stalling',
      run: async (request) => {
        await stalled;
        return scripted.run(request);
      }
    };
    const run = runAgentAction(
      s.deps(stalling, { kinds, modelTimeoutMs: 600_000 }),
      task(AGENT_TEAM, 'evt-1', 'lineup')
    );
    // Wait for the worker to be inside its model call, holding the call's estimate.
    let [hold] = await held(s);
    for (let i = 0; hold === undefined && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      [hold] = await held(s);
    }
    expect(hold).toMatchObject({ key: usageKey(1, 1), taskId: 'lineup.evt-1.team-2' });

    // Not before the attempt's lease runs out.
    expect(await recoverAgentTasks(s.services)).toMatchObject({ holds: 0 });
    s.clock.advance(TASK_LOCK_MS);
    expect(await recoverAgentTasks(s.services)).toMatchObject({ holds: 1, settled: 1 });
    expect(await recoverAgentTasks(s.services)).toMatchObject({ holds: 0 });
    expect(await held(s)).toEqual([]);
    // The call may have run: its estimate is charged, flagged as an estimate.
    expect(await totals(s)).toEqual({
      inputTokens: hold?.inputTokens,
      outputTokens: hold?.outputTokens,
      costUsd: hold?.costUsd,
      tasks: 0
    });
    expect(s.logs.some((l) => l.includes('agent budget hold outlived its attempt'))).toBe(true);

    // The worker wakes up: its own charge for that call is a duplicate; the task still counts once.
    release();
    const record = await run;
    expect(record).toMatchObject({ status: 'completed' });
    expect(await totals(s)).toEqual({
      inputTokens: hold?.inputTokens,
      outputTokens: hold?.outputTokens,
      costUsd: hold?.costUsd,
      tasks: 1
    });
    expect(await held(s)).toEqual([]);
  });
});
