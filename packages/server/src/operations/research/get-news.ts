import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { NFL_TEAMS, PlayerRefSchema, playerSelectorShape, toPlayerRef } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import type { NewsItem, NewsQuery } from '../../repos/reference.js';

const HOUR_MS = 3_600_000;
export const DEFAULT_NEWS_WINDOW_HOURS = 72;

const NewsItemSchema = z.object({
  id: z.string().describe('Stable news id.'),
  title: z.string(),
  url: z.string().describe('Link to the full article.'),
  source: z.string().describe('The outlet, e.g. "ESPN".'),
  publishedAt: z.string().describe('When the outlet published it (ISO 8601).'),
  players: z.array(PlayerRefSchema).describe('Players the article names.'),
  teams: z.array(z.string()).describe('NFL teams the article names (abbreviations).'),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe('The feed’s own description. Present when `detail` is true.')
});

export const getNews = defineOperation({
  name: 'get_news',
  method: 'GET',
  path: '/news',
  summary: 'Recent NFL news, for a player, a team, or the whole league',
  description: [
    'Returns recent NFL headlines from free RSS feeds (ESPN, CBS Sports, and others), newest first, each tagged with the players and teams it names.',
    'Pass `playerId` or `player` for one player’s news (injuries, depth chart, trades), `team` for a team’s, or neither for the league-wide feed.',
    'By default it covers the last 72 hours; widen it with `since` (ISO 8601) or narrow it with `until`. News is refreshed every 15 minutes.',
    'Headlines are not summarized or verified: open `url` for the full story, and weigh the source. `detail: true` adds the feed’s description.',
    'An unknown player returns PLAYER_NOT_FOUND; an ambiguous name returns AMBIGUOUS_PLAYER with candidates.'
  ].join(' '),
  tags: ['research'],
  mutation: false,
  input: z.object({
    ...playerSelectorShape,
    team: z
      .enum(NFL_TEAMS)
      .optional()
      .describe('NFL team abbreviation, e.g. "BUF". Ignored when a player is given.'),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only items published at or after this time (ISO 8601). Default: 72 hours ago.'),
    until: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only items published at or before this time (ISO 8601). Default: now.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum items (1-50, default 10).'),
    detail: z.boolean().default(false).describe('Set true to include each item’s feed description.')
  }),
  output: z.object({ items: z.array(NewsItemSchema) }),
  handler: async (ctx, input) => {
    const now = ctx.clock.now();
    const until = input.until === undefined ? now : new Date(input.until);
    const since =
      input.since === undefined
        ? new Date(now.getTime() - DEFAULT_NEWS_WINDOW_HOURS * HOUR_MS)
        : new Date(input.since);
    if (since.getTime() > until.getTime()) {
      throw new ApiError('INVALID_INPUT', '`since` is after `until`.', {
        fix: 'Pass a `since` earlier than `until`, or omit both for the last 72 hours.'
      });
    }
    const query: NewsQuery = { since, until, limit: input.limit };
    const news = ctx.data.reference.news;
    let items: NewsItem[];
    if (input.playerId !== undefined || input.player !== undefined) {
      const player = await ctx.data.players.resolve(input);
      items = await news.listByPlayer(player.id, query);
    } else if (input.team !== undefined) {
      items = await news.listByTeam(input.team, query);
    } else {
      items = await news.listRecent(query);
    }
    const ids = [...new Set(items.flatMap((i) => i.playerIds))];
    const players = new Map((await ctx.repos.players.getMany(ids)).map((p) => [p.id, toPlayerRef(p)]));
    return {
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt,
        players: item.playerIds.flatMap((id) => {
          const ref = players.get(id);
          return ref === undefined ? [] : [ref];
        }),
        teams: item.teams,
        ...(input.detail ? { summary: item.summary } : {})
      }))
    };
  }
});
