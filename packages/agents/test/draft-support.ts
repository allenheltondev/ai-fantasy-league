import { FixedClock } from '@fantasy/core';
import {
  InMemoryEventPublisher,
  createContext,
  createInMemoryRepos,
  createLogger,
  createServices,
  executeOperation,
  fixtureDraftPool,
  registry,
  type Envelope,
  type Player,
  type Principal,
  type Repos,
  type Services
} from '@fantasy/server';
import { OFF_SWITCH, type KillSwitch } from '../src/kill-switch.js';
import type { AgentActionRequested } from '../src/events.js';
import type { ModelClient } from '../src/model.js';
import type { RunnerDeps } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';

/** Allen: the commissioner and the one human in the league (seat 1). */
export const ALLEN: Principal = { type: 'user', sub: 'allen', email: 'allen@example.com', name: 'Allen' };

export interface DraftSetup {
  repos: Repos;
  services: Services;
  clock: FixedClock;
  events: InMemoryEventPublisher;
  logs: string[];
  leagueId: string;
  /** Runs an operation through the real pipeline as `principal` (default Allen). */
  run(name: string, input: Record<string, unknown>, principal?: Principal): Promise<Envelope>;
  deps(model: ModelClient, options?: { killSwitch?: KillSwitch }): RunnerDeps;
  /** The task request the router would send for the latest `Draft Turn Started`. */
  turnRequest(): AgentActionRequested;
}

let keys = 0;

/**
 * A league created and drafted through the real operations: Allen creates it (one human seat, the
 * rest agent seats), `seats` configures agents before the draft, and `start_draft` starts it.
 */
export async function draftSetup(
  options: {
    teamCount?: number;
    players?: readonly Player[];
    order?: string[];
    start?: string;
    beforeStart?: (s: Omit<DraftSetup, 'turnRequest'>) => Promise<void>;
  } = {}
): Promise<DraftSetup> {
  const repos = createInMemoryRepos({ players: options.players ?? fixtureDraftPool });
  const clock = new FixedClock(options.start ?? '2026-09-09T12:00:00.000Z');
  const events = new InMemoryEventPublisher();
  const logs: string[] = [];
  const services = createServices({ clock, repos, events, log: createLogger({ sink: (l) => logs.push(l) }) });
  const run = async (name: string, input: Record<string, unknown>, principal: Principal = ALLEN) => {
    const operation = registry.get(name);
    if (operation === undefined) throw new Error(`no operation ${name}`);
    const result = await executeOperation({
      registry,
      operation,
      ctx: createContext(services, principal),
      input,
      idempotencyKey: operation.mutation ? `test-key-${++keys}-0000` : null
    });
    return result.body;
  };
  const created = await run('create_league', { name: 'Mock Draft', teamCount: options.teamCount ?? 4 });
  if ('error' in created) throw new Error(JSON.stringify(created.error));
  const leagueId = (created.data as { id: string }).id;
  const deps = (model: ModelClient, o: { killSwitch?: KillSwitch } = {}): RunnerDeps => ({
    registry,
    services,
    kinds: defaultTaskKinds,
    model,
    killSwitch: o.killSwitch ?? OFF_SWITCH
  });
  const base = { repos, services, clock, events, logs, leagueId, run, deps };
  await options.beforeStart?.(base);
  const started = await run('start_draft', {
    leagueId,
    ...(options.order === undefined ? {} : { order: options.order })
  });
  if ('error' in started) throw new Error(JSON.stringify(started.error));
  return {
    ...base,
    turnRequest() {
      const turn = events.events.filter((e) => e.detailType === 'Draft Turn Started').at(-1);
      if (turn === undefined) throw new Error('no turn');
      const teamId = turn.detail.teamId as string;
      return {
        taskId: `draft_pick.${leagueId}.${String(turn.detail.pick)}`,
        leagueId,
        teamId,
        agentId: `${leagueId}.${teamId}`,
        kind: 'draft_pick',
        trigger: {
          detailType: 'Draft Turn Started',
          eventId: `turn-${String(turn.detail.pick)}`,
          urgent: true
        },
        payload: { pick: turn.detail.pick, round: turn.detail.round, deadline: turn.detail.deadline },
        requestedAt: clock.now().toISOString()
      };
    }
  };
}
