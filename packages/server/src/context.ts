import { randomUUID } from 'node:crypto';
import type { Clock } from '@fantasy/core';
import type { KillSwitch } from './agents/kill-switch.js';
import type { Principal } from './auth/principal.js';
import type { EventPublisher } from './events/publisher.js';
import type { NflStateSource } from './league/calendar.js';
import type { Logger } from './log.js';
import type { PlayerDirectory } from './players/directory.js';
import type { Realtime } from './realtime/realtime.js';
import type { Registry } from './registry/registry.js';
import type { ReferenceStore } from './repos/reference.js';
import type { Repos } from './repos/types.js';

/**
 * Reference data services: the player directory (search + name resolution) and the
 * reference store the scheduled jobs fill (NFL state, schedule, stats, projections,
 * trending, news). Handlers read stored data only; jobs talk to `@fantasy/data`.
 */
export interface DataServices {
  players: PlayerDirectory;
  reference: ReferenceStore;
  /** The current NFL season and week. Optional: league creation estimates from the clock without it. */
  nflState?: NflStateSource;
}

/** Per-deployment limits, from the environment (see `limitsFromEnv`). */
export interface Limits {
  /** Active (not complete) leagues one user may have created. */
  leaguesPerUser: number;
  /** User ids or emails (lowercase) exempt from `leaguesPerUser`. */
  unlimitedUsers: readonly string[];
}

/**
 * Where new record ids come from. Production uses random UUIDs; the season replay simulator passes
 * a seeded source so the same seed gives the same league (its id seeds the schedule and agents).
 */
export interface IdSource {
  uuid(): string;
}

export const DEFAULT_LIMITS: Limits = { leaguesPerUser: 3, unlimitedUsers: [] };

/** Reads `LEAGUE_QUOTA` (a whole number) and `LEAGUE_QUOTA_ADMINS` (comma-separated subs or emails). */
export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  const quota = env.LEAGUE_QUOTA?.trim() ?? '';
  return {
    leaguesPerUser: /^\d+$/.test(quota) ? Number(quota) : DEFAULT_LIMITS.leaguesPerUser,
    unlimitedUsers: (env.LEAGUE_QUOTA_ADMINS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  };
}

/** What every handler receives. Never read the wall clock: use `ctx.clock.now()`. */
export interface Ctx {
  principal: Principal;
  clock: Clock;
  repos: Repos;
  events: EventPublisher;
  data: DataServices;
  log: Logger;
  limits: Limits;
  /** AppSync Events for live updates (a no-op when not configured). */
  realtime: Realtime;
  /** New record ids (random UUIDs when not set; see `newId`). */
  ids?: IdSource;
  /** The global agent kill switch (SSM), when this deployment has one; read-only here. */
  agentKillSwitch?: KillSwitch;
  /** The registry running this operation (set by `executeOperation`), for allowed-action lists. */
  registry?: Registry;
}

/** Everything a request needs except the principal: built once per container. */
export interface Services {
  clock: Clock;
  repos: Repos;
  events: EventPublisher;
  data: DataServices;
  log: Logger;
  limits: Limits;
  realtime: Realtime;
  ids?: IdSource;
  agentKillSwitch?: KillSwitch;
}

export function createContext(services: Services, principal: Principal, log: Logger = services.log): Ctx {
  return {
    principal,
    clock: services.clock,
    repos: services.repos,
    events: services.events,
    data: services.data,
    log,
    limits: services.limits,
    realtime: services.realtime,
    ...(services.ids === undefined ? {} : { ids: services.ids }),
    ...(services.agentKillSwitch === undefined ? {} : { agentKillSwitch: services.agentKillSwitch })
  };
}

/** A new record id from the context's id source, or a random UUID. */
export function newId(ctx: Pick<Ctx, 'ids'>): string {
  return ctx.ids?.uuid() ?? randomUUID();
}
