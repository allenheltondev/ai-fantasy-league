import type { TrendingEntry } from '@fantasy/data';
import { z } from 'zod';
import { PlayerRefSchema, PositionSchema, toPlayerRef } from '../../players/model.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';

/**
 * Picks the cached lookback window to serve: the smallest one that covers the request, else the
 * largest cached (so 200h falls back to 168h).
 */
export function chooseLookback(cached: readonly number[], requested: number): number | null {
  const sorted = [...cached].sort((a, b) => a - b);
  return sorted.find((h) => h >= requested) ?? sorted[sorted.length - 1] ?? null;
}

export const getTrendingPlayers = defineOperation({
  name: 'get_trending_players',
  method: 'GET',
  path: '/players/trending',
  summary: 'Players being added or dropped the most across fantasy leagues',
  description: [
    'Returns the NFL players most added (`type: "add"`) or dropped (`type: "drop"`) across Sleeper fantasy leagues over a lookback window, with the transaction count.',
    'It is a crowd signal for waiver decisions: breakout players and injury replacements show up in adds; injured, benched, or cut players in drops.',
    'Data refreshes hourly and covers 24, 72, or 168 hours; `lookbackHours` returns the closest cached window that covers the request and echoes the one used.',
    'Filter by `position` to find, say, trending RBs. It does not say whether a player is available in your league.',
    'An empty list with a NO_TRENDING_DATA warning means no snapshot is stored yet.'
  ].join(' '),
  tags: ['research', 'players'],
  mutation: false,
  input: z.object({
    type: z
      .enum(['add', 'drop'])
      .default('add')
      .describe('`add` (default) for most-added, `drop` for most-dropped.'),
    lookbackHours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24)
      .describe('How far back to count transactions, in hours (1-168, default 24).'),
    position: PositionSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum players (1-50, default 10).')
  }),
  output: z.object({
    type: z.enum(['add', 'drop']),
    lookbackHours: z
      .number()
      .int()
      .nullable()
      .describe('The lookback window actually served, or null with no data.'),
    capturedAt: z
      .string()
      .nullable()
      .describe('When the counts were pulled (ISO 8601), or null with no data.'),
    players: z
      .array(
        z.object({
          player: PlayerRefSchema,
          count: z.number().int().describe('Adds or drops in the window.')
        })
      )
      .describe('Most transactions first.')
  }),
  handler: async (ctx, input) => {
    const snapshot = await ctx.data.reference.trending.latest(input.type, ctx.clock.now());
    const cached = snapshot === null ? [] : Object.keys(snapshot.lookbacks).map(Number);
    const lookback = chooseLookback(cached, input.lookbackHours);
    if (snapshot === null || lookback === null) {
      return withWarnings({ type: input.type, lookbackHours: null, capturedAt: null, players: [] }, [
        {
          code: 'NO_TRENDING_DATA',
          message: 'No trending snapshot is stored yet. Try again after the hourly refresh.'
        }
      ]);
    }
    const entries: TrendingEntry[] = snapshot.lookbacks[String(lookback)] ?? [];
    const profiles = new Map(
      (await ctx.repos.players.getMany(entries.map((e) => e.playerId))).map((p) => [p.id, p])
    );
    const players = entries
      .flatMap((entry) => {
        const player = profiles.get(entry.playerId);
        return player === undefined ? [] : [{ player, count: entry.count }];
      })
      .filter(({ player }) => input.position === undefined || player.position === input.position)
      .slice(0, input.limit)
      .map(({ player, count }) => ({ player: toPlayerRef(player), count: Math.round(count) }));
    return { type: input.type, lookbackHours: lookback, capturedAt: snapshot.capturedAt, players };
  }
});
