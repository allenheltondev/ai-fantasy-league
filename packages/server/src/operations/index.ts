import { createRegistry, type Registry } from '../registry/registry.js';
import { getPlayer, searchPlayers } from './players.js';
import { getHealth, getMe } from './system.js';
import { getAgentActivity } from './agents/activity.js';
import { configureAgentSeat, getAgentSeat, randomizeAgentSeatsOperation } from './agents/seats.js';

/** Every operation the API serves. Add new operations here. */
export const operations = [
  getHealth,
  getMe,
  searchPlayers,
  getPlayer,
  // Agent platform (#39, #45)
  configureAgentSeat,
  randomizeAgentSeatsOperation,
  getAgentSeat,
  getAgentActivity
];

export const registry: Registry = createRegistry(operations);
