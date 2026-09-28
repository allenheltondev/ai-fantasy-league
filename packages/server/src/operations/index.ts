import { createRegistry, type Registry } from '../registry/registry.js';
import { leagueOperations } from './league/index.js';
import { getPlayer, searchPlayers } from './players.js';
import { getHealth, getMe } from './system.js';
import { getAgentActivity } from './agents/activity.js';
import { getAgentCatalog } from './agents/catalog.js';
import { configureAgentSeat, getAgentSeat, randomizeAgentSeatsOperation } from './agents/seats.js';
import { getNews } from './research/get-news.js';
import { getProjections } from './research/get-projections.js';
import { getTrendingPlayers } from './research/get-trending-players.js';
import { waiverOperations } from './waivers/index.js';

/** Every operation the API serves. Add new operations here. */
export const operations = [
  getHealth,
  getMe,
  searchPlayers,
  getPlayer,
  // Research (player and NFL data the scheduled jobs keep fresh)
  getProjections,
  getTrendingPlayers,
  getNews,
  // League lifecycle, membership, and settings
  ...leagueOperations,
  // Agent platform (#39, #45)
  configureAgentSeat,
  randomizeAgentSeatsOperation,
  getAgentSeat,
  getAgentActivity,
  getAgentCatalog,
  // Waivers and free agency (#55)
  ...waiverOperations
];

export const registry: Registry = createRegistry(operations);
