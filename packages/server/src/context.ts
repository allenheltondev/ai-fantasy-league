import type { Clock } from '@fantasy/core';
import type { Principal } from './auth/principal.js';
import type { EventPublisher } from './events/publisher.js';
import type { Logger } from './log.js';
import type { PlayerDirectory } from './players/directory.js';
import type { Repos } from './repos/types.js';

/**
 * Reference data services. The player directory (search + name resolution) lives
 * here now; the `@fantasy/data` DataProvider joins it when that package lands.
 */
export interface DataServices {
  players: PlayerDirectory;
}

/** What every handler receives. Never read the wall clock: use `ctx.clock.now()`. */
export interface Ctx {
  principal: Principal;
  clock: Clock;
  repos: Repos;
  events: EventPublisher;
  data: DataServices;
  log: Logger;
}

/** Everything a request needs except the principal: built once per container. */
export interface Services {
  clock: Clock;
  repos: Repos;
  events: EventPublisher;
  data: DataServices;
  log: Logger;
}

export function createContext(services: Services, principal: Principal, log: Logger = services.log): Ctx {
  return {
    principal,
    clock: services.clock,
    repos: services.repos,
    events: services.events,
    data: services.data,
    log
  };
}
