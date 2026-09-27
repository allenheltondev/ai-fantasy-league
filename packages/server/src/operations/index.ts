import { createRegistry, type Registry } from '../registry/registry.js';
import { getPlayer, searchPlayers } from './players.js';
import { getHealth, getMe } from './system.js';

/** Every operation the API serves. Add new operations here. */
export const operations = [getHealth, getMe, searchPlayers, getPlayer];

export const registry: Registry = createRegistry(operations);
