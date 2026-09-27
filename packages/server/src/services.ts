import type { Clock } from '@fantasy/core';
import type { Services } from './context.js';
import type { EventPublisher } from './events/publisher.js';
import type { Logger } from './log.js';
import { PlayerDirectory } from './players/directory.js';
import { createInMemoryReferenceStore } from './repos/memory-reference.js';
import type { ReferenceStore } from './repos/reference.js';
import type { Repos } from './repos/types.js';

/** Wires the per-container services every request shares. */
export function createServices(options: {
  clock: Clock;
  repos: Repos;
  events: EventPublisher;
  log: Logger;
  playerIndexTtlMs?: number;
  /** Reference data (stats, projections, news, ...). Defaults to an in-memory store. */
  reference?: ReferenceStore;
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
    data: { players, reference: options.reference ?? createInMemoryReferenceStore(options.repos.players) }
  };
}
