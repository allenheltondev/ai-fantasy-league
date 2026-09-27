import type { Clock } from '@fantasy/core';
import { DEFAULT_LIMITS, type Limits, type Services } from './context.js';
import type { EventPublisher } from './events/publisher.js';
import type { NflStateSource } from './league/calendar.js';
import type { Logger } from './log.js';
import { PlayerDirectory } from './players/directory.js';
import type { Repos } from './repos/types.js';

/** Wires the per-container services every request shares. */
export function createServices(options: {
  clock: Clock;
  repos: Repos;
  events: EventPublisher;
  log: Logger;
  playerIndexTtlMs?: number;
  nflState?: NflStateSource;
  limits?: Limits;
}): Services {
  const players = new PlayerDirectory({
    repo: options.repos.players,
    clock: options.clock,
    ...(options.playerIndexTtlMs === undefined ? {} : { ttlMs: options.playerIndexTtlMs })
  });
  return {
    clock: options.clock,
    repos: options.repos,
    events: options.events,
    log: options.log,
    data: options.nflState === undefined ? { players } : { players, nflState: options.nflState },
    limits: options.limits ?? DEFAULT_LIMITS
  };
}
