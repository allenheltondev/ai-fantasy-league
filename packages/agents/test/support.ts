import { FixedClock, type AgentSeatConfig } from '@fantasy/core';
import {
  ApiError,
  InMemoryEventPublisher,
  agentIdFor,
  createInMemoryRepos,
  createLogger,
  createRegistry,
  createServices,
  defineOperation,
  operations,
  type League,
  type Registry,
  type Repos,
  type Services
} from '@fantasy/server';
import { z } from 'zod';
import { OFF_SWITCH, type KillSwitch } from '../src/kill-switch.js';
import type { ModelClient } from '../src/model.js';
import type { RunnerDeps } from '../src/runner.js';
import { defaultTaskKinds } from '../src/tasks/index.js';
import type { TaskKindRegistry } from '../src/tasks/kinds.js';

export const START = '2026-10-04T15:00:00.000Z';
export const LEAGUE_ID = 'lg-1';
export const AGENT_TEAM = 'team-2';

export type RosterRow = {
  playerId: string;
  name: string;
  positions: string[];
  status: string;
  nflTeam: string | null;
  slot: string;
  projectedPoints?: number;
};

/** A legal Yahoo-default roster: 15 players, currently with a weak lineup. */
export function roster(): RosterRow[] {
  const p = (playerId: string, pos: string, slot: string, pts: number, status = 'active'): RosterRow => ({
    playerId,
    name: playerId.toUpperCase(),
    positions: [pos],
    status,
    nflTeam: 'SF',
    slot,
    projectedPoints: pts
  });
  return [
    p('qb1', 'QB', 'BN', 20),
    p('qb2', 'QB', 'QB', 12),
    p('rb1', 'RB', 'RB', 15),
    p('rb2', 'RB', 'RB', 12),
    p('rb3', 'RB', 'BN', 11),
    p('wr1', 'WR', 'WR', 16),
    p('wr2', 'WR', 'WR', 14),
    p('wr3', 'WR', 'WR', 9),
    p('wr4', 'WR', 'W/R/T', 3),
    p('wr5', 'WR', 'BN', 13, 'out'),
    p('te1', 'TE', 'TE', 8),
    p('te2', 'TE', 'BN', 4),
    p('k1', 'K', 'K', 7),
    p('def1', 'DEF', 'DEF', 6),
    p('rb4', 'RB', 'BN', 2)
  ];
}

/** Stand-ins for the lineup stream's operations, with the contract the lineup task expects. */
export function fakeLineupOps(state: {
  rosters: Map<string, RosterRow[]>;
  lineups: { teamId: string; lineup: unknown }[];
}) {
  const own = (principal: { type: string; teamId?: string }, teamId: string) => {
    if (principal.type === 'agent' && principal.teamId !== teamId) {
      throw new ApiError('FORBIDDEN', 'You can only change your own team.', { fix: 'Use your own teamId.' });
    }
  };
  const getRoster = defineOperation({
    name: 'get_roster',
    method: 'GET',
    path: '/leagues/{leagueId}/teams/{teamId}/roster',
    summary: 'Get a roster (test)',
    description: 'Test stand-in for the lineup stream.',
    mutation: false,
    input: z.object({ leagueId: z.string(), teamId: z.string(), week: z.number().int().optional() }),
    output: z.object({ week: z.number().int(), roster: z.array(z.record(z.string(), z.unknown())) }),
    handler: async (_ctx, input) => ({ week: 5, roster: state.rosters.get(input.teamId) ?? [] })
  });
  const getProjections = defineOperation({
    name: 'get_projections',
    method: 'GET',
    path: '/leagues/{leagueId}/projections',
    summary: 'Get projections (test)',
    description: 'Test research tool.',
    mutation: false,
    input: z.object({ leagueId: z.string(), week: z.number().int(), playerIds: z.array(z.string()) }),
    output: z.object({ projections: z.array(z.object({ playerId: z.string(), points: z.number() })) }),
    handler: async (_ctx, input) => ({
      projections: input.playerIds.filter((id) => id === 'rb3').map((playerId) => ({ playerId, points: 30 }))
    })
  });
  const getNews = defineOperation({
    name: 'get_news',
    method: 'GET',
    path: '/players/news',
    summary: 'Get news (test)',
    description: 'Test research tool gated by news access.',
    tags: ['research:news'],
    mutation: false,
    input: z.object({ playerId: z.string().optional() }),
    output: z.object({ items: z.array(z.string()) }),
    handler: async () => ({ items: ['Practiced in full.'] })
  });
  const setLineup = defineOperation({
    name: 'set_lineup',
    method: 'PUT',
    path: '/leagues/{leagueId}/teams/{teamId}/lineup',
    summary: 'Set a lineup (test)',
    description: 'Test stand-in for the lineup stream.',
    mutation: true,
    input: z.object({
      leagueId: z.string(),
      teamId: z.string(),
      week: z.number().int().optional(),
      lineup: z.array(z.object({ playerId: z.string(), slot: z.string() }))
    }),
    output: z.object({ ok: z.boolean() }),
    handler: async (ctx, input) => {
      own(ctx.principal as { type: string; teamId?: string }, input.teamId);
      state.lineups.push({ teamId: input.teamId, lineup: input.lineup });
      return { ok: true };
    }
  });
  return [getRoster, getProjections, getNews, setLineup];
}

export interface Setup {
  repos: Repos;
  services: Services;
  clock: FixedClock;
  events: InMemoryEventPublisher;
  registry: Registry;
  state: { rosters: Map<string, RosterRow[]>; lineups: { teamId: string; lineup: unknown }[] };
  logs: string[];
  deps(
    model: ModelClient,
    options?: { killSwitch?: KillSwitch; kinds?: TaskKindRegistry; modelTimeoutMs?: number }
  ): RunnerDeps;
  seat(teamId: string, config: AgentSeatConfig): Promise<void>;
}

export function league(overrides: Partial<League> = {}): League {
  return {
    id: LEAGUE_ID,
    name: 'Test League',
    season: 2026,
    phase: 'pre_lock',
    week: 5,
    commissionerSub: 'user-123',
    teamCount: 4,
    createdAt: START,
    updatedAt: START,
    version: 1,
    ...overrides
  };
}

export async function setup(
  options: { withLineupOps?: boolean; league?: Partial<League> } = {}
): Promise<Setup> {
  const repos = createInMemoryRepos();
  await repos.leagues.create(league(options.league));
  const clock = new FixedClock(START);
  const events = new InMemoryEventPublisher();
  const logs: string[] = [];
  const services = createServices({ clock, repos, events, log: createLogger({ sink: (l) => logs.push(l) }) });
  const state = {
    rosters: new Map([
      [AGENT_TEAM, roster()],
      ['team-3', roster()]
    ]),
    lineups: [] as { teamId: string; lineup: unknown }[]
  };
  const registry = createRegistry([
    ...operations,
    ...(options.withLineupOps === false ? [] : fakeLineupOps(state))
  ]);
  return {
    repos,
    services,
    clock,
    events,
    registry,
    state,
    logs,
    deps: (model, o = {}) => ({
      registry,
      services,
      kinds: o.kinds ?? defaultTaskKinds,
      model,
      killSwitch: o.killSwitch ?? OFF_SWITCH,
      ...(o.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: o.modelTimeoutMs })
    }),
    async seat(teamId, config) {
      const current = await repos.agents.getSeat(LEAGUE_ID, teamId);
      await repos.agents.putSeat({
        leagueId: LEAGUE_ID,
        teamId,
        agentId: agentIdFor(LEAGUE_ID, teamId),
        config,
        version: (current?.version ?? 0) + 1,
        updatedAt: START,
        updatedBy: 'user#user-123'
      });
    }
  };
}
