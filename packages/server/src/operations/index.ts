import { createRegistry, type Registry } from '../registry/registry.js';
import { getPlayer, searchPlayers } from './players.js';
import { getHealth, getMe } from './system.js';
import { getNews } from './research/get-news.js';
import { getProjections } from './research/get-projections.js';
import { getTrendingPlayers } from './research/get-trending-players.js';

/** Every operation the API serves. Add new operations here. */
export const operations = [
  getHealth,
  getMe,
  searchPlayers,
  getPlayer,
  // Research (player and NFL data the scheduled jobs keep fresh)
  getProjections,
  getTrendingPlayers,
  getNews
];

export const registry: Registry = createRegistry(operations);
