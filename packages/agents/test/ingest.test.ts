import type { EventSubscriber } from '@fantasy/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '../src/events.js';
import { ScriptedModelClient } from '../src/fake-model.js';
import { INGESTED_EVENTS, ingestLeagueEvent } from '../src/ingest.js';
import { agentSubscribers, inProcessAgentDeps } from '../src/loop.js';
import { MEMORY_EVENTS, type AgentMemoryStore } from '../src/memory.js';
import { TRIGGER_RULES } from '../src/router.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import { AGENT_TEAM, LEAGUE_ID, START, setup, type Setup } from './support.js';
import { routerRuleEvents } from './template.js';

/**
 * Production parity (#211): the router Lambda and the in-process event loop (dev server, e2e, the
 * season simulator) ingest league events through one path, so the same event stream leaves the
 * same agent memory and the same task outcomes in both.
 */

const OTHER_AGENT = 'team-3';
const SEAT = { personalityId: 'stats-nerd', difficulty: 'pro', archetype: 'balanced' } as const;
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();

function event(id: string, detailType: string, detail: Record<string, unknown>, minutes = 0): BusEvent {
  return { id, 'detail-type': detailType, source: 'fantasy', time: at(minutes), detail };
}

/** One environment: its league, and how it delivers an event (and the agent tasks it requests). */
interface Environment {
  s: Setup;
  deliver(event: BusEvent): Promise<unknown>;
  failures: string[];
}

async function seatedLeague(): Promise<Setup> {
  const s = await setup();
  await s.seat(AGENT_TEAM, SEAT);
  await s.seat(OTHER_AGENT, SEAT);
  return s;
}

/**
 * Delivers like EventBridge or `EventLoop`: to every subscriber of the detail type, a throw
 * recorded rather than stopping delivery. Agent tasks the delivery requested are then delivered
 * the same way (ids derived from the trigger's, so both environments see the same ids).
 */
function environment(s: Setup, subscribers: readonly EventSubscriber[]): Environment {
  const failures: string[] = [];
  let cursor = s.events.events.length;
  const dispatch = async (e: BusEvent) => {
    const results: unknown[] = [];
    for (const sub of subscribers) {
      if (sub.detailTypes !== undefined && !sub.detailTypes.includes(e['detail-type'])) continue;
      try {
        results.push(await sub.handle(e));
      } catch (error) {
        failures.push(`${sub.name} ${e.id}: ${String(error)}`);
      }
    }
    return results;
  };
  return {
    s,
    failures,
    async deliver(e) {
      const routed = await dispatch(e);
      const requested = s.events.events
        .slice(cursor)
        .filter((r) => r.detailType === 'Agent Action Requested');
      cursor = s.events.events.length;
      for (const [n, r] of requested.entries()) {
        await dispatch({
          id: `${e.id}.task-${n}`,
          'detail-type': r.detailType,
          source: r.source,
          time: e.time,
          detail: r.detail
        });
      }
      return routed;
    }
  };
}

/** The Lambdas, as deployed: the router on its EventBridge rule's events, the task runner on requests. */
async function production(): Promise<Environment> {
  const s = await seatedLeague();
  vi.stubEnv('TABLE_NAME', 'unused');
  vi.stubEnv('FANTASY_FAKE_MODEL', '1');
  // The in-process loop keeps delays off; the comparison is of what is decided, not when.
  vi.stubEnv('AGENT_RESPONSE_DELAYS', 'off');
  vi.resetModules();
  vi.doMock('../src/lambda/env.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/lambda/env.js')>()),
    createAgentServices: () => s.services
  }));
  const router = await import('../src/lambda/router.js');
  const task = await import('../src/lambda/task.js');
  return environment(s, [
    { name: 'agent-router', detailTypes: routerRuleEvents(), handle: router.handler },
    { name: 'agent-task', detailTypes: ['Agent Action Requested'], handle: task.handler }
  ]);
}

async function inProcess(): Promise<Environment> {
  const s = await seatedLeague();
  return environment(s, agentSubscribers(inProcessAgentDeps(s.services, new ScriptedModelClient())));
}

/** Fails the next memory write (a throttled or unavailable table), once. */
function failNextMemoryWrite(s: Setup): void {
  const original = s.repos.agents.updateMemory.bind(s.repos.agents);
  s.repos.agents.updateMemory = async () => {
    s.repos.agents.updateMemory = original;
    throw new Error('table unavailable');
  };
}

const week4 = (home: number, away: number) => ({
  leagueId: LEAGUE_ID,
  week: 4,
  matchups: [
    { homeTeamId: 'team-1', awayTeamId: AGENT_TEAM, homeScore: home, awayScore: away },
    { homeTeamId: OTHER_AGENT, awayTeamId: 'team-4', homeScore: 88, awayScore: 70 }
  ]
});
const trade = {
  leagueId: LEAGUE_ID,
  tradeId: 'tr-1',
  fromTeamId: 'team-1',
  toTeamId: AGENT_TEAM,
  fromPlayers: [{ name: 'Allen RB' }],
  toPlayers: [{ name: 'Agent WR' }]
};

/** A league week's worth of agent-relevant events, with redelivery, a late step, and a failed write. */
async function play(env: Environment): Promise<unknown[]> {
  const out: unknown[] = [];
  const deliver = async (e: BusEvent) => out.push(await env.deliver(e));
  const provisional = event('w4-provisional', 'Week Provisionally Final', week4(100, 99), 0);
  const lock = event('lock-5', 'Lineup Lock Approaching', { leagueId: LEAGUE_ID, week: 5 }, 10);
  const accepted = event('tr-1-accepted', 'Trade Accepted', trade, 20);
  const processed = event('tr-1-processed', 'Trade Processed', trade, 40);
  const official = event('w4-official', 'Week Official Final', week4(100, 101), 60);

  await deliver(provisional);
  await deliver(lock);
  await deliver(processed);
  // Ordering: the acceptance lands after the processing it led to.
  await deliver(accepted);
  // A failed memory write: the correction is lost this time, and routing still runs.
  failNextMemoryWrite(env.s);
  await deliver(official);
  // Redelivery (EventBridge delivers at least once): the correction lands, nothing doubles.
  await deliver(official);
  await deliver(provisional);
  await deliver(lock);
  await deliver(processed);
  return out;
}

async function outcomes(env: Environment) {
  const { repos } = env.s;
  const memory = async (teamId: string) => repos.agents.getMemory(LEAGUE_ID, `${LEAGUE_ID}.${teamId}`);
  const tasks = (await repos.agents.listTasks(LEAGUE_ID)).map((t) => ({
    taskId: t.taskId,
    teamId: t.teamId,
    kind: t.kind,
    status: t.status,
    finalAction: t.finalAction,
    trigger: t.trigger,
    reasoningSummary: t.reasoningSummary
  }));
  return {
    memories: { [AGENT_TEAM]: await memory(AGENT_TEAM), [OTHER_AGENT]: await memory(OTHER_AGENT) },
    tasks: tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    lineups: await env.s.savedLineups(),
    failures: env.failures
  };
}

describe('shared event ingestion (#211)', () => {
  afterEach(() => {
    vi.doUnmock('../src/lambda/env.js');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('ingests the union of routing triggers and memory-only events, as the router rule does', () => {
    expect(new Set(INGESTED_EVENTS)).toEqual(new Set([...Object.keys(TRIGGER_RULES), ...MEMORY_EVENTS]));
    expect(new Set(routerRuleEvents())).toEqual(new Set(INGESTED_EVENTS));
    const router = agentSubscribers(inProcessAgentDeps({} as never, new ScriptedModelClient())).find(
      (sub) => sub.name === 'agent-router'
    );
    expect(router?.detailTypes).toEqual(INGESTED_EVENTS);
    // Memory-only events reach the in-process loop now (before #211 they never did).
    expect(MEMORY_EVENTS.filter((t) => !(t in TRIGGER_RULES)).length).toBeGreaterThan(0);
  });

  it('leaves equal memory and outcomes in the Lambdas and the in-process loop for one event stream', async () => {
    const lambda = await production();
    const loop = await inProcess();
    const lambdaResults = await play(lambda);
    const loopResults = await play(loop);

    // Each delivery decided the same thing (the in-process loop's subscriber returns the same result).
    const routed = (results: unknown[]) => results.map((r) => (r as unknown[])[0]);
    expect(routed(loopResults)).toEqual(routed(lambdaResults));
    const [lambdaOut, loopOut] = [await outcomes(lambda), await outcomes(loop)];
    expect(loopOut).toEqual(lambdaOut);

    // And what they agree on is right.
    const mine = lambdaOut.memories[AGENT_TEAM];
    // The failed correction was filled by its redelivery: official, corrected, one result for the week.
    expect(mine.results).toEqual([
      {
        teamId: 'team-1',
        week: 4,
        pointsFor: 101,
        pointsAgainst: 100,
        at: at(0),
        official: true,
        corrected: true
      }
    ]);
    // The late acceptance did not roll the processed trade back; what moved is kept.
    expect(mine.trades).toMatchObject([
      {
        tradeId: 'tr-1',
        outcome: 'processed',
        direction: 'incoming',
        sent: ['Agent WR'],
        received: ['Allen RB']
      }
    ]);
    // Each league event applied once, whatever was redelivered.
    expect(new Set(mine.seen).size).toBe(mine.seen.length);
    expect(mine.seen.sort()).toEqual(['tr-1-accepted', 'tr-1-processed', 'w4-official', 'w4-provisional']);
    expect(lambdaOut.memories[OTHER_AGENT].results).toMatchObject([
      { teamId: 'team-4', week: 4, pointsFor: 88, official: true }
    ]);
    // The lock ran one lineup task per agent (the redelivered trigger ran nothing again), and the
    // trade acceptance put the trade to the other agent's vote.
    const kinds = lambdaOut.tasks.map((t) => `${t.teamId}:${t.kind}`).sort();
    expect(kinds.filter((k) => k.endsWith(':lineup'))).toEqual([
      `${AGENT_TEAM}:lineup`,
      `${OTHER_AGENT}:lineup`
    ]);
    expect(lambdaOut.lineups).toHaveLength(1);
    expect(lambda.s.logs.some((l) => l.includes('agent memory update failed'))).toBe(true);
    expect(loop.s.logs.some((l) => l.includes('agent memory update failed'))).toBe(true);
  });

  it('routes an event whose memory write failed, and reports nothing remembered', async () => {
    const s = await seatedLeague();
    const store: AgentMemoryStore = {
      load: async () => {
        throw new Error('unused');
      },
      remember: async () => {
        throw new Error('table unavailable');
      }
    };
    const deps = { services: s.services, kinds: defaultTaskKinds, memory: store };
    const lock = event('lock', 'Lineup Lock Approaching', { leagueId: LEAGUE_ID, week: 5 });
    const result = await ingestLeagueEvent(deps, lock);
    expect(result.remembered).toBe(0);
    expect(result.decisions.map((d) => d.decision)).toEqual(['requested', 'requested']);
    const final = await ingestLeagueEvent(deps, event('final', 'Week Provisionally Final', week4(1, 2)));
    expect(final).toEqual({ decisions: [], remembered: 0 });
    expect(s.logs.filter((l) => l.includes('agent memory update failed'))).toHaveLength(1);
  });
});
