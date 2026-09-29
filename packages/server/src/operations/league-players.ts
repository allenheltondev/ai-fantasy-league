import { PlayerStatusSchema } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../league/access.js';
import { actorTeam } from '../league/phase.js';
import { LeagueIdSchema } from '../league/views.js';
import { AVAILABILITY_FILTERS, StandingSchema, standingView } from '../players/availability.js';
import { loadMarket, MARKET_SORTS } from '../players/market.js';
import { NFL_TEAMS, PlayerDetailSchema, POSITIONS, toPlayerDetail } from '../players/model.js';
import { defineOperation } from '../registry/operation.js';
import { dropClearsAt } from '../waivers/rosters.js';
import { PlayerGameSchema } from './season/views.js';

/** The most rows one page returns. */
export const MARKET_PAGE_MAX = 50;

const MarketPlayerSchema = z.object({
  player: PlayerDetailSchema,
  availability: StandingSchema,
  status: PlayerStatusSchema.describe(
    'Availability to play: active, questionable, doubtful, out, ir, pup, nfi, suspended, covid, na.'
  ),
  injuryStatus: z.string().nullable().describe('The raw injury designation, e.g. "Questionable", or null.'),
  byeWeek: z.number().int().nullable().describe("His NFL team's bye week, or null when unknown."),
  game: PlayerGameSchema,
  projectedPoints: z
    .number()
    .nullable()
    .describe('Projected points this week under league scoring, or null (bye, or not projected).'),
  projectedRos: z
    .number()
    .nullable()
    .describe('Projected points from this week through week 18 under league scoring, or null.'),
  seasonPoints: z.number().nullable().describe('Points scored this season under league scoring, or null.'),
  average: z.number().nullable().describe('Points per game played this season, or null with no games.'),
  games: z.number().int().describe('Games played this season.'),
  trend: z
    .object({
      adds: z.number().int().describe('Adds across Sleeper leagues in the trending window.'),
      drops: z.number().int().describe('Drops across Sleeper leagues in the trending window.')
    })
    .nullable()
    .describe('The crowd’s adds and drops over `trendHours`, or null when no trending data is stored.')
});

export const listLeaguePlayers = defineOperation({
  name: 'list_league_players',
  method: 'GET',
  path: '/leagues/{leagueId}/players',
  summary: 'The player market: available players with projections, games, and trends, sorted and paged',
  description: [
    'Lists players for a pickup or trade decision in your league, a page at a time. By default it lists available players (free agents and players on waivers), best projection this week first.',
    'Each row has where he stands in the league (`availability`), his game this week (`game`: opponent, kickoff, or live score), bye week, injury, projected points this week and rest of season, season points and average under league scoring, and the crowd’s adds and drops (`trend`).',
    '`sort`: projected_week (default), projected_ros, season_points, average, trending (adds minus drops), or rank (consensus). Players without the value sort last; ties go to consensus rank.',
    'Filter with `position` (QB, RB, WR, TE, K, DEF, or FLEX for RB/WR/TE), `team`, `q` (a name), `healthy: true` (no injury designation), and `availability` (available, free_agent, waivers, rostered, or all). Without `q` it lists players on NFL teams.',
    'Page with `offset` and `limit` (at most 50): pass `nextOffset` back for the next page; it is null on the last. The order is stable, so pages never repeat a player.',
    'Add a free agent or claim a waiver player with claim_waiver; `faabRemaining` and `dropClearsAt` (when a player you drop now clears waivers) help plan the move.'
  ].join(' '),
  tags: ['players', 'waivers', 'research:trending'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    q: z.string().trim().min(1).max(80).optional().describe('Name, nickname, or partial name.'),
    position: z
      .enum([...POSITIONS, 'FLEX'])
      .optional()
      .describe('QB, RB, WR, TE, K, DEF, or FLEX (RB, WR, and TE).'),
    team: z.enum(NFL_TEAMS).optional().describe('NFL team abbreviation, e.g. "SF".'),
    availability: z
      .enum([...AVAILABILITY_FILTERS, 'all'])
      .default('available')
      .describe(
        '`available` (default: free agents and waivers), `free_agent`, `waivers`, `rostered` (on a team: trade targets), or `all`.'
      ),
    healthy: z
      .boolean()
      .default(false)
      .describe('Set true to leave out players with any injury designation.'),
    sort: z
      .enum(MARKET_SORTS)
      .default('projected_week')
      .describe('projected_week (default), projected_ros, season_points, average, trending, or rank.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .default(0)
      .describe('Rows to skip: the previous page’s `nextOffset`.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MARKET_PAGE_MAX)
      .default(25)
      .describe('Rows per page (1-50, default 25).')
  }),
  output: z.object({
    season: z.number().int(),
    week: z.number().int().describe('The league week the projections and games are for.'),
    total: z.number().int().describe('Players matching the filters, across every page.'),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe('The `offset` of the next page, or null on the last page.'),
    trendHours: z
      .number()
      .int()
      .nullable()
      .describe('The trending window in hours, or null when no trending data is stored.'),
    waiverType: z.enum(['faab', 'rolling']).describe('FAAB bids, or rolling waiver priority.'),
    faabRemaining: z.number().int().nullable().describe('Your FAAB left, or null when you manage no team.'),
    dropClearsAt: z
      .string()
      .nullable()
      .describe('When a player you drop now would clear waivers (ISO 8601), or null with no waiver period.'),
    players: z.array(MarketPlayerSchema)
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const page = await loadMarket(ctx, access, {
      q: input.q,
      position: input.position,
      team: input.team,
      availability: input.availability,
      healthyOnly: input.healthy,
      sort: input.sort,
      offset: input.offset,
      limit: input.limit
    });
    const settings = access.league.settings;
    return {
      season: access.league.season,
      week: page.week,
      total: page.total,
      nextOffset: page.nextOffset,
      trendHours: page.trendHours,
      waiverType: settings.waivers.type,
      faabRemaining: actorTeam(access.actor)?.faabRemaining ?? null,
      dropClearsAt: dropClearsAt(settings, ctx.clock.now()),
      players: page.rows.map((row) => ({
        player: toPlayerDetail(row.player, true),
        availability: standingView(row.standing),
        status: row.status,
        injuryStatus: row.player.injuryStatus,
        byeWeek: row.byeWeek,
        game: row.game,
        projectedPoints: row.projectedPoints,
        projectedRos: row.projectedRos,
        seasonPoints: row.seasonPoints,
        average: row.average,
        games: row.games,
        trend: row.trend
      }))
    };
  }
});
