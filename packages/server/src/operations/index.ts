import { createRegistry, type Registry } from '../registry/registry.js';
import { draftOperations } from './draft/index.js';
import { leagueOperations } from './league/index.js';
import { getPlayer, searchPlayers } from './players.js';
import { getHealth, getMe } from './system.js';
import { getAgentActivity } from './agents/activity.js';
import { getAgentCatalog } from './agents/catalog.js';
import { configureAgentSeat, getAgentSeat, randomizeAgentSeatsOperation } from './agents/seats.js';
import { getNews } from './research/get-news.js';
import { getProjections } from './research/get-projections.js';
import { getTrendingPlayers } from './research/get-trending-players.js';
import { seasonOperations } from './season/index.js';

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
  // Season loop: rosters and lineups (#52)
  ...seasonOperations,
  // Draft (#46, #47)
  ...draftOperations,
  // Agent platform (#39, #45)
  configureAgentSeat,
  randomizeAgentSeatsOperation,
  getAgentSeat,
  getAgentActivity,
  getAgentCatalog
];

export const registry: Registry = createRegistry(operations);
