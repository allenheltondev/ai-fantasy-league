import { FixedClock, type AgentSeatConfig, type RosterSlot, yahooDefaultSettings } from '@fantasy/core';
import {
  InMemoryEventPublisher,
  agentIdFor,
  createInMemoryRepos,
  createLogger,
  createRegistry,
  createServices,
  newTeam,
  operations,
  type League,
  type Player,
  type Registry,
  type Repos,
  type Services
} from '@fantasy/server';
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

export interface Setup {
  repos: Repos;
  services: Services;
  clock: FixedClock;
  events: InMemoryEventPublisher;
  registry: Registry;
  /** Lineups the agents saved through set_lineup, oldest first. */
  savedLineups(teamId?: string): Promise<{ teamId: string; lineup: { playerId: string; slot: string }[] }[]>;
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
    phase: 'regular_season',
    week: 5,
    settings: yahooDefaultSettings(4),
    commissionerId: 'user-123',
    commissionerName: 'Allen',
    createdBy: 'user-123',
    scheduleSeed: 'seed-1',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
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
  const l = league(options.league);
  await seedLeague(repos, l);
  const clock = new FixedClock(START);
  const events = new InMemoryEventPublisher();
  const logs: string[] = [];
  const services = createServices({ clock, repos, events, log: createLogger({ sink: (l) => logs.push(l) }) });
  await seedResearch(repos, services);
  await seedRosters(repos, l);
  const registry = createRegistry(
    options.withLineupOps === false
      ? operations.filter((op) => op.name !== 'get_roster' && op.name !== 'set_lineup')
      : operations
  );
  return {
    repos,
    services,
    clock,
    events,
    registry,
    async savedLineups(teamId = AGENT_TEAM) {
      const saved = await repos.lineups.get(LEAGUE_ID, teamId, l.week ?? 5);
      return saved === null || !saved.updatedBy.startsWith('agent#')
        ? []
        : [{ teamId, lineup: saved.entries }];
    },
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

/**
 * The roster's players in the player directory, a projection snapshot where only rb3 projects,
 * and the week's NFL schedule: SF (every player's team) kicks off Sunday afternoon.
 */
async function seedResearch(repos: Repos, services: Services): Promise<void> {
  await repos.players.putMany(
    roster().map((r) => ({
      id: r.playerId,
      name: r.name,
      firstName: r.name,
      lastName: r.name,
      team: r.nflTeam,
      position: r.positions[0] as Player['position'],
      status: 'active',
      injuryStatus: r.status === 'out' ? 'Out' : null,
      aliases: [],
      rank: null,
      updatedAt: START
    }))
  );
  const season = league().season;
  const week = league().week ?? 5;
  // 300 rushing yards is 30 points under any preset, enough for rb3 to start over rb2.
  await services.data.reference.projections.putSnapshot(
    { season, week, capturedAt: '2026-10-01T12:00:00.000Z', hash: 'agents-test', count: 1 },
    [{ playerId: 'rb3', season, week, stats: { rush_yd: 300 } }]
  );
  await services.data.reference.schedule.putSeason(
    season,
    [
      {
        gameId: `${season}_05_LAR_SF`,
        season,
        seasonType: 'regular',
        week,
        kickoff: SF_KICKOFF,
        homeTeam: 'SF',
        awayTeam: 'LAR',
        status: 'scheduled'
      }
    ],
    {},
    new Date(START)
  );
}

/** The kickoff of every rostered player's game in week 5 (after START, so nobody is locked). */
export const SF_KICKOFF = '2026-10-04T20:25:00.000Z';

/** team-2 and team-3 roster `roster()`, with its (weak) lineup saved for the current week. */
async function seedRosters(repos: Repos, l: League): Promise<void> {
  for (const teamId of [AGENT_TEAM, 'team-3']) {
    const team = await repos.teams.get(l.id, teamId);
    if (team === null) continue;
    await repos.teams.update({ ...team, roster: roster().map((r) => r.playerId) });
    await repos.lineups.put([
      {
        leagueId: l.id,
        teamId,
        week: l.week ?? 5,
        entries: roster().map((r) => ({ playerId: r.playerId, slot: r.slot as RosterSlot })),
        updatedAt: START,
        updatedBy: 'user#seed'
      }
    ]);
  }
}

/** The league with its four teams: team-1 is the commissioner's (a person); team-2..team-4 are agent seats. */
async function seedLeague(repos: Repos, l: League): Promise<void> {
  await repos.leagues.create(l);
  const now = new Date(START);
  const teams = [1, 2, 3, 4].map((slot) =>
    newTeam({
      leagueId: l.id,
      id: `team-${slot}`,
      draftSlot: slot,
      settings: l.settings,
      now,
      ...(slot === 1 ? { owner: { userId: 'user-123', name: 'Allen', teamName: "Allen's Team" } } : {})
    })
  );
  await repos.teams.create(teams);
  await repos.members.add({ leagueId: l.id, userId: 'user-123', teamId: 'team-1', joinedAt: START });
}
