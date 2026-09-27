import { readFileSync } from 'node:fs';
import type { Clock } from '@fantasy/core';
import type { FetchLike } from '../src/http/http-client.js';
import type { Player } from '../src/types.js';

export const FIXTURES = new URL('../fixtures/', import.meta.url);

export function fixtureText(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}

export function fixtureJson(path: string): unknown {
  return JSON.parse(fixtureText(path)) as unknown;
}

/** Reads `new Date()`, so it follows vitest fake timers. */
export const wallClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

export type Route = (url: URL, call: number) => Response | Promise<Response>;

export interface MockFetch {
  fetch: FetchLike;
  calls: string[];
}

/** A fetch that answers from `route` and records every requested URL. */
export function mockFetch(route: Route): MockFetch {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    return route(new URL(input), calls.length);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status });
}

/** Serves `packages/data/fixtures` for Sleeper and nflverse URLs. */
export const fixtureRoute: Route = (url) => {
  const p = url.pathname;
  const weekly = /^\/v1\/(stats|projections)\/nfl\/regular\/(\d+)\/(\d+)$/.exec(p);
  if (p === '/v1/players/nfl') return new Response(fixtureText('sleeper/players.json'));
  if (p === '/v1/state/nfl') return new Response(fixtureText('sleeper/state.json'));
  if (weekly) {
    try {
      return new Response(fixtureText(`sleeper/${weekly[1]}_regular_${weekly[2]}_${weekly[3]}.json`));
    } catch {
      return json(null);
    }
  }
  const trending = /^\/v1\/players\/nfl\/trending\/(add|drop)$/.exec(p);
  if (trending) return new Response(fixtureText(`sleeper/trending_${trending[1]}.json`));
  if (p.endsWith('/db_playerids.csv')) return text(fixtureText('nflverse/db_playerids.csv'));
  if (p.endsWith('/stats_player_week_2025.csv'))
    return text(fixtureText('nflverse/stats_player_week_2025.csv'));
  if (p.endsWith('/games.csv')) return text(fixtureText('nflverse/games_2025.csv'));
  return text('not found', 404);
};

export function makePlayer(overrides: Partial<Player> & { id: string }): Player {
  return {
    name: `Player ${overrides.id}`,
    firstName: 'Player',
    lastName: overrides.id,
    team: 'KC',
    position: 'WR',
    fantasyPositions: ['WR'],
    status: 'Active',
    injuryStatus: null,
    depthChartOrder: 1,
    depthChartPosition: 'WR',
    active: true,
    searchNames: [`player ${overrides.id}`],
    ...overrides
  };
}
