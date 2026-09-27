import type { Clock } from '@fantasy/core';
import type { Services } from './context.js';
import type { EventPublisher } from './events/publisher.js';
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
    data: { players }
  };
}
