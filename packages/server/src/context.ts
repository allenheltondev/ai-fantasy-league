import type { Clock } from '@fantasy/core';
import type { Principal } from './auth/principal.js';
import type { EventPublisher } from './events/publisher.js';
import type { NflStateSource } from './league/calendar.js';
import type { Logger } from './log.js';
import type { PlayerDirectory } from './players/directory.js';
import type { Registry } from './registry/registry.js';
import type { Repos } from './repos/types.js';

/**
 * Reference data services. The player directory (search + name resolution) lives
 * here now; the `@fantasy/data` DataProvider joins it when that package lands.
 */
export interface DataServices {
  players: PlayerDirectory;
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
}

export function createContext(services: Services, principal: Principal, log: Logger = services.log): Ctx {
  return {
    principal,
    clock: services.clock,
    repos: services.repos,
    events: services.events,
    data: services.data,
    log,
    limits: services.limits
  };
}
