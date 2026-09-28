import type { Clock } from '@fantasy/core';
import type { Principal } from './auth/principal.js';
import type { EventPublisher } from './events/publisher.js';
import type { Logger } from './log.js';
import type { PlayerDirectory } from './players/directory.js';
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
