import { z } from 'zod';
import {
  NFL_TEAMS,
  PlayerDetailSchema,
  PositionSchema,
  playerSelectorShape,
  toPlayerDetail
} from '../players/model.js';
import { ApiError } from '../errors.js';
import {
  applyAvailability,
  AVAILABILITY_SEARCH_POOL,
  AvailabilitySchema,
  StandingSchema,
  standingView
} from '../players/availability.js';
import { defineOperation } from '../registry/operation.js';

/** `detail` arrives as a string in a query and as a boolean in JSON; both parse here. */
export const detailFlag = z
  .boolean()
  .default(false)
  .describe('Set true for full player records (status, injury, aliases, rank). Default is compact.');

export const searchPlayers = defineOperation({
  name: 'search_players',
  method: 'GET',
  path: '/players',
  summary: 'Search NFL players by name, team, or position',
  description: [
    'Finds players in the NFL player universe. Use it to find a player id, or to browse a position or team.',
    '`q` matches full names, last names, name prefixes, nicknames ("CMC"), and small typos; add a team or position to narrow it ("mccaffrey sf", "allen qb").',
    'With no `q`, returns the best-ranked players that match `position` and `team`.',
    'Results are ranked best match first.',
    'Pass your `leagueId` to see where each player stands in your league (`availability`: free_agent, waivers with the time he clears, or rostered with the team), and add `availability` to list only those players, e.g. `availability: "free_agent"` for pickups you can add right now with claim_waiver.'
  ].join(' '),
  tags: ['players'],
  mutation: false,
  input: z.object({
    q: z.string().trim().min(1).max(80).optional().describe('Name, nickname, or partial name.'),
    position: PositionSchema.optional(),
    team: z
      .enum(NFL_TEAMS)
      .optional()
      .describe('NFL team abbreviation, e.g. "SF". Free agents have no team.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum results (1-50, default 10).'),
    detail: detailFlag,
    leagueId: z
      .string()
      .min(1)
      .optional()
      .describe('Your league id: adds each player’s league availability. Required with `availability`.'),
    availability: AvailabilitySchema.optional()
  }),
  output: z.object({
    players: z.array(PlayerDetailSchema.extend({ availability: StandingSchema.optional() }))
  }),
  handler: async (ctx, input) => {
    if (input.availability !== undefined && input.leagueId === undefined) {
      throw new ApiError('INVALID_INPUT', '`availability` needs a league.', {
        fix: 'Pass `leagueId` with `availability`, or drop `availability` to search every player.'
      });
    }
    const players = await ctx.data.players.search({
      query: input.q,
      position: input.position,
      team: input.team,
      limit: input.availability === undefined ? input.limit : AVAILABILITY_SEARCH_POOL
    });
    if (input.leagueId === undefined) {
      return { players: players.map((p) => toPlayerDetail(p, input.detail)) };
    }
    const filtered = await applyAvailability(ctx, players, {
      leagueId: input.leagueId,
      availability: input.availability
    });
    return {
      players: filtered.players.slice(0, input.limit).map((p) => ({
        ...toPlayerDetail(p, input.detail),
        availability: standingView(filtered.standingOf(p.id))
      }))
    };
  }
});

export const getPlayer = defineOperation({
  name: 'get_player',
  method: 'GET',
  path: '/players/lookup',
  summary: 'Get one player by id or name',
  description: [
    'Returns a single player. Pass `playerId` when you have it; otherwise pass `player` with a name or nickname.',
    'If the name matches several players you get AMBIGUOUS_PLAYER with `details.candidates`: retry with one candidate id.',
    'An unknown id or name returns PLAYER_NOT_FOUND; use search_players to find the right one.',
    'Responses are compact unless `detail` is true.'
  ].join(' '),
  tags: ['players'],
  mutation: false,
  input: z.object({ ...playerSelectorShape, detail: detailFlag }),
  output: z.object({ player: PlayerDetailSchema }),
  handler: async (ctx, input) => {
    const player = await ctx.data.players.resolve(input);
    return { player: toPlayerDetail(player, input.detail) };
  }
});
