import {
  DEFAULT_ROOM_ID,
  dmRoomId,
  yahooDefaultSettings,
  type AgentSeatConfig,
  type RosterSlot
} from '@fantasy/core';
import {
  AgentActionRequestedSchema,
  agentSubscribers,
  inProcessAgentDeps,
  runAgentAction,
  ingestLeagueEvent,
  type AgentAblation,
  type AgentActionRequested,
  type ModelClient
} from '@fantasy/agents';
import {
  EventLoop,
  InMemoryEventPublisher,
  agentIdFor,
  createInMemoryRepos,
  createServices,
  newTeam,
  serverSubscribers,
  silentLogger,
  type BusEvent,
  type ChatMessage,
  type Envelope,
  type KillSwitch,
  type League,
  type Player,
  type Principal,
  type Repos,
  type Services
} from '@fantasy/server';
import { SimClock } from '../clock/sim-clock.js';
import { dataOf, operationRunner, type RunOperation } from '../replay/human.js';

/**
 * A small, fully controlled league on the simulated clock for the epic #219 acceptance scenario:
 * the real operations, the league's event handlers, and the agents' router and runner, wired
 * through one `EventLoop` exactly as the season replay wires them. Unlike a replay, its rosters,
 * projections, and injuries are chosen by the scenario, so "an injury creates exactly one RB need"
 * is a fact the test sets up, not a hope about an archive.
 *
 * - team-1 is a person (the commissioner, `PERSON`); team-2 is the agent under test; team-3 and
 *   team-4 are empty seats nobody plays.
 * - Week 5 of the 2026 regular season. Every rostered player's game kicks off a week after the
 *   start, so nothing locks while the scenario's days go by.
 * - Injuries are written to the player directory, the store the league's player sync fills in
 *   production: that is what "authoritative" means here.
 */

export const WORLD_START = '2026-10-06T13:00:00.000Z';
export const WORLD_LEAGUE = 'lg-accept';
export const PERSON_TEAM = 'team-1';
export const AGENT_TEAM = 'team-2';
export const DM_ROOM = dmRoomId(PERSON_TEAM, AGENT_TEAM);
/** A league room everyone reads. */
export const PUBLIC_ROOM = DEFAULT_ROOM_ID;
export const KICKOFF = '2026-10-13T17:00:00.000Z';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const PERSON = { type: 'user', sub: 'user-accept', email: null, name: 'Allen' } satisfies Principal;

interface Seeded {
  id: string;
  position: Player['position'];
  slot: RosterSlot;
  /** Projected points this week (10 yards a point). */
  points: number;
}

/**
 * The agent's roster: exactly two running backs, so one injury leaves one RB slot it cannot fill,
 * and four receivers for three WR slots and the W/R/T flex (a second injury opens the flex).
 */
export const AGENT_ROSTER: readonly Seeded[] = [
  { id: 'qb1', position: 'QB', slot: 'QB', points: 20 },
  { id: 'qb2', position: 'QB', slot: 'BN', points: 12 },
  { id: 'rb1', position: 'RB', slot: 'RB', points: 15 },
  { id: 'rb2', position: 'RB', slot: 'RB', points: 12 },
  { id: 'wr1', position: 'WR', slot: 'WR', points: 16 },
  { id: 'wr2', position: 'WR', slot: 'WR', points: 14 },
  { id: 'wr3', position: 'WR', slot: 'WR', points: 12 },
  { id: 'wr4', position: 'WR', slot: 'W/R/T', points: 10 },
  { id: 'te1', position: 'TE', slot: 'TE', points: 8 },
  { id: 'k1', position: 'K', slot: 'K', points: 7 },
  { id: 'def1', position: 'DEF', slot: 'DEF', points: 6 },
  { id: 'qb3', position: 'QB', slot: 'BN', points: 9 },
  { id: 'k2', position: 'K', slot: 'BN', points: 5 },
  { id: 'def2', position: 'DEF', slot: 'BN', points: 4 }
];

/** The person's roster: a starting-calibre back they pitch, and a spare one. */
export const PERSON_ROSTER: readonly Seeded[] = [
  { id: 'p-qb', position: 'QB', slot: 'QB', points: 18 },
  // A backup QB a little better than the agent's third: a small gain that a bar of 1 clears and 2 does not.
  { id: 'p-qb2', position: 'QB', slot: 'BN', points: 9.5 },
  { id: 'p-rb1', position: 'RB', slot: 'RB', points: 14 },
  { id: 'p-rb2', position: 'RB', slot: 'RB', points: 11 },
  { id: 'p-rb3', position: 'RB', slot: 'BN', points: 13 },
  { id: 'p-wr1', position: 'WR', slot: 'WR', points: 15 },
  { id: 'p-wr2', position: 'WR', slot: 'WR', points: 13 },
  { id: 'p-wr3', position: 'WR', slot: 'WR', points: 11 },
  { id: 'p-wr4', position: 'WR', slot: 'W/R/T', points: 9 },
  { id: 'p-te', position: 'TE', slot: 'TE', points: 7 },
  { id: 'p-k', position: 'K', slot: 'K', points: 6 },
  { id: 'p-def', position: 'DEF', slot: 'DEF', points: 5 }
];

/** Display names: `rb1` is "Rb1 Agent", `p-rb3` is "Rb3 Person" (unique, so chat can name them). */
export function playerName(id: string): string {
  const person = id.startsWith('p-');
  const base = person ? id.slice(2) : id;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} ${person ? 'Person' : 'Agent'}`;
}

/** The stat each position projects, and yards per point under the default scoring. */
const STAT: Partial<Record<Player['position'], [string, number]>> = {
  QB: ['pass_yd', 25],
  RB: ['rush_yd', 10],
  WR: ['rec_yd', 10],
  TE: ['rec_yd', 10]
};

export interface WorldOptions {
  config: AgentSeatConfig;
  /** The agents' model (default: the scenario's scripted model). */
  model: ModelClient;
  killSwitch?: KillSwitch;
  ablations?: readonly AgentAblation[];
  /** Human-like response delays (#189), as the router Lambda has them; off by default. */
  responseDelays?: boolean;
  /** Loses the matching task requests on the way to the runner (a dispatch that never arrived). */
  lose?: (request: AgentActionRequested) => boolean;
}

export interface AcceptanceWorld {
  services: Services;
  repos: Repos;
  clock: SimClock;
  events: InMemoryEventPublisher;
  loop: EventLoop;
  run: RunOperation;
  deps: ReturnType<typeof inProcessAgentDeps>;
  league: League;
  agentId: string;
  /** Every event the loop delivered, in order (for redelivery). */
  delivered: BusEvent[];
  /** Runs an operation as the person; throws on an error envelope. */
  person<T>(name: string, input: Record<string, unknown>): Promise<T>;
  /** Runs an operation as the person and returns the envelope, error or not. */
  attempt(name: string, input: Record<string, unknown>): Promise<Envelope>;
  /** The person posts in a room (the DM by default) and the loop delivers what follows. */
  say(text: string, roomId?: string): Promise<ChatMessage>;
  /** Sets players' injury designations in the directory (null heals them). */
  injure(ids: readonly string[], status: string | null): Promise<void>;
  /** A manager check-in in `slot`, delivered now. */
  checkIn(slot: 'morning' | 'afternoon' | 'evening'): Promise<void>;
  /** Moves the clock forward, delivering what comes due on the way. */
  advance(ms: number): Promise<void>;
  /** Delivers `event` again to the agents' router, as a duplicate delivery would. */
  redeliver(event: BusEvent): Promise<void>;
  /** Runs an agent task request again, as a duplicate delivery would. */
  rerun(request: AgentActionRequested): Promise<void>;
  /** Every agent task request delivered so far, oldest first. */
  requests(): AgentActionRequested[];
}

export async function buildWorld(options: WorldOptions): Promise<AcceptanceWorld> {
  const repos = createInMemoryRepos();
  const clock = new SimClock([], WORLD_START);
  const events = new InMemoryEventPublisher();
  const settings = yahooDefaultSettings(4);
  const league: League = {
    id: WORLD_LEAGUE,
    name: 'Acceptance League',
    season: 2026,
    phase: 'regular_season',
    week: 5,
    settings,
    commissionerId: PERSON.sub,
    commissionerName: 'Allen',
    createdBy: PERSON.sub,
    scheduleSeed: 'accept',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: WORLD_START,
    updatedAt: WORLD_START,
    version: 1
  };
  await repos.leagues.create(league);
  const now = new Date(WORLD_START);
  await repos.teams.create(
    [1, 2, 3, 4].map((slot) =>
      newTeam({
        leagueId: league.id,
        id: `team-${slot}`,
        draftSlot: slot,
        settings,
        now,
        ...(slot === 1 ? { owner: { userId: PERSON.sub, name: 'Allen', teamName: "Allen's Team" } } : {})
      })
    )
  );
  await repos.members.add({
    leagueId: league.id,
    userId: PERSON.sub,
    teamId: PERSON_TEAM,
    joinedAt: WORLD_START
  });
  // Numbered ids (message, trade, and record ids), so a run is the same every time.
  let n = 0;
  const ids = { uuid: () => `accept-${String(++n).padStart(5, '0')}` };
  const services = createServices({ clock, repos, events, log: silentLogger, ids });

  // Players, rosters, saved lineups, the week's projections, and the one game everyone plays in.
  const rostered = [...AGENT_ROSTER, ...PERSON_ROSTER];
  await repos.players.putMany(
    rostered.map((p) => {
      const name = playerName(p.id);
      const [first, last] = name.split(' ') as [string, string];
      return {
        id: p.id,
        name,
        firstName: first,
        lastName: last,
        team: 'SF',
        position: p.position,
        status: 'active' as const,
        injuryStatus: null,
        aliases: [],
        rank: null,
        updatedAt: WORLD_START
      };
    })
  );
  for (const [teamId, seeded] of [
    [AGENT_TEAM, AGENT_ROSTER],
    [PERSON_TEAM, PERSON_ROSTER]
  ] as const) {
    const team = await repos.teams.get(league.id, teamId);
    /* v8 ignore next -- the teams were created above */
    if (team === null) throw new Error(`No ${teamId}.`);
    await repos.teams.update({ ...team, roster: seeded.map((p) => p.id) });
    await repos.lineups.put([
      {
        leagueId: league.id,
        teamId,
        week: 5,
        entries: seeded.map((p) => ({ playerId: p.id, slot: p.slot })),
        updatedAt: WORLD_START,
        updatedBy: 'user#seed'
      }
    ]);
  }
  const lines = rostered.flatMap((p) => {
    const stat = STAT[p.position];
    if (stat === undefined) return [];
    return [{ playerId: p.id, season: 2026, week: 5, stats: { [stat[0]]: p.points * stat[1] } }];
  });
  await services.data.reference.projections.putSnapshot(
    { season: 2026, week: 5, capturedAt: '2026-10-05T12:00:00.000Z', hash: 'accept', count: lines.length },
    lines
  );
  await services.data.reference.schedule.putSeason(
    2026,
    [
      {
        gameId: '2026_05_LAR_SF',
        season: 2026,
        seasonType: 'regular',
        week: 5,
        kickoff: KICKOFF,
        homeTeam: 'SF',
        awayTeam: 'LAR',
        status: 'scheduled'
      }
    ],
    {},
    now
  );

  const agentId = agentIdFor(league.id, AGENT_TEAM);
  await repos.agents.putSeat({
    leagueId: league.id,
    teamId: AGENT_TEAM,
    agentId,
    config: options.config,
    version: 1,
    updatedAt: WORLD_START,
    updatedBy: `user#${PERSON.sub}`
  });

  const deps = inProcessAgentDeps(services, options.model, {
    responseDelays: options.responseDelays ?? false,
    ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }),
    ...(options.ablations === undefined ? {} : { ablations: options.ablations })
  });
  const lose = options.lose;
  const agents = agentSubscribers(deps).map((s) =>
    lose === undefined || s.name !== 'agent-task'
      ? s
      : {
          ...s,
          handle: (event: BusEvent) =>
            lose(AgentActionRequestedSchema.parse(event.detail)) ? Promise.resolve() : s.handle(event)
        }
  );
  const delivered: BusEvent[] = [];
  const loop = new EventLoop({
    publisher: events,
    clock,
    subscribers: [
      {
        name: 'accept-record',
        handle: (event) => {
          delivered.push(event);
          return Promise.resolve();
        }
      },
      ...serverSubscribers(services),
      ...agents
    ],
    log: silentLogger
  });
  const run = operationRunner(services);
  const attempt = (name: string, input: Record<string, unknown>) =>
    run(name, { leagueId: league.id, ...input }, PERSON);
  const world: AcceptanceWorld = {
    services,
    repos,
    clock,
    events,
    loop,
    run,
    deps,
    league,
    agentId,
    delivered,
    attempt,
    async person<T>(name: string, input: Record<string, unknown>) {
      const envelope = await attempt(name, input);
      await loop.drain();
      return dataOf<T>(envelope, name);
    },
    async say(text, roomId = DM_ROOM) {
      const posted = await world.person<{ message: ChatMessage }>('post_message', { roomId, text });
      return posted.message;
    },
    async injure(ids, status) {
      const players = await repos.players.getMany([...ids]);
      await repos.players.putMany(players.map((p) => ({ ...p, injuryStatus: status })));
    },
    async checkIn(slot) {
      const at = clock.now();
      await events.publish('Manager Check-In', {
        leagueId: league.id,
        slot,
        date: at.toISOString().slice(0, 10),
        at: at.toISOString(),
        nextAt: new Date(at.getTime() + 5 * HOUR).toISOString(),
        week: 5
      });
      await loop.drain();
    },
    async advance(ms) {
      await loop.runUntil(new Date(clock.now().getTime() + ms));
    },
    async redeliver(event) {
      await ingestLeagueEvent(deps.router, event);
      await loop.drain();
    },
    async rerun(request) {
      await runAgentAction(deps.runner, request);
      await loop.drain();
    },
    requests() {
      return delivered
        .filter((e) => e['detail-type'] === 'Agent Action Requested')
        .map((e) => AgentActionRequestedSchema.parse(e.detail));
    }
  };
  return world;
}
