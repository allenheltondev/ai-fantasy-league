import { z } from 'zod';
import { PlayerDetailSchema, playerSelectorShape, toPlayerDetail } from '../../players/model.js';
import { loadCurrentForm } from '../../players/current-form.js';
import { cardTotals, loadResearch } from '../../players/research.js';
import { defineOperation } from '../../registry/operation.js';
import { leagueIdField, scoringFor } from './shared.js';

/** How many recent news items a card shows. */
export const CARD_NEWS_LIMIT = 3;

const TotalsSchema = z
  .record(z.string(), z.number())
  .describe(
    'Season totals by Sleeper stat key for the position: passing (pass_att, pass_cmp, pass_yd, pass_td, pass_int), rushing (rush_att = carries, rush_yd, rush_td), receiving (rec_tgt = targets, rec, rec_yd, rec_td), kicking (fgm, fga, fgm_50p, xpm, xpa), or team defense (sack, int, fum_rec, def_td, safe, pts_allow, yds_allow).'
  );

export const getPlayerCard = defineOperation({
  name: 'get_player_card',
  method: 'GET',
  path: '/players/card',
  summary:
    'One player’s card: this season so far, next week’s projection and matchup, last season, the season projection, and news',
  description: [
    'Returns one player’s card: this season’s fantasy points so far, week by week, with points per game and key stat totals, plus his last three games in detail: points, versus his average, the opponent, and where the points came from (`thisSeason`, `thisSeason.recent`); his projection for the current NFL week with his opponent, or his bye (`nextWeek`); last regular season’s points each week plus totals, points per game, and key stat totals; this season’s projected points and stat totals; his bye week and injury designation; and up to 3 recent news headlines.',
    'Pass `leagueId` to score with your league’s settings (you must be a member); otherwise points use Yahoo standard half-PPR, and `scoring.source` says which was used.',
    '`lastSeason` is null for rookies and players with no stats last season; `projection` is null until projections are published; `thisSeason` is null until he has a stat line this season; `nextWeek` is null in the offseason, and its `points` are null until that week’s projections are published. Use it before a draft pick, a start/sit call, a waiver claim, or a trade.',
    'An unknown player returns PLAYER_NOT_FOUND; an ambiguous name returns AMBIGUOUS_PLAYER with candidates.'
  ].join(' '),
  tags: ['research', 'players'],
  mutation: false,
  input: z.object({ ...playerSelectorShape, leagueId: leagueIdField }),
  output: z.object({
    player: PlayerDetailSchema,
    scoring: z.object({
      source: z
        .enum(['league', 'default'])
        .describe('`league`: the league’s settings. `default`: Yahoo standard half-PPR.')
    }),
    bye: z.number().int().nullable().describe('Bye week this season, or null when unknown.'),
    injuryStatus: z.string().nullable().describe('Injury designation, or null when healthy.'),
    lastSeason: z
      .object({
        season: z.number().int(),
        points: z.number(),
        ppg: z.number().describe('Points per game played; 0 with no games.'),
        games: z.number().int(),
        weekly: z
          .array(z.object({ week: z.number().int(), points: z.number() }))
          .describe('Points each week he has a line for, in week order (missing weeks: bye or no game).'),
        totals: TotalsSchema
      })
      .nullable(),
    projection: z
      .object({
        season: z.number().int(),
        points: z.number().describe('Projected fantasy points for the season.'),
        totals: TotalsSchema
      })
      .nullable(),
    thisSeason: z
      .object({
        season: z.number().int(),
        points: z.number().describe('Fantasy points this season so far.'),
        ppg: z.number().describe('Points per game played; 0 with no games.'),
        games: z.number().int(),
        weekly: z
          .array(z.object({ week: z.number().int(), points: z.number() }))
          .describe('Points each week he has a line for, in week order.'),
        totals: TotalsSchema,
        recent: z
          .array(
            z.object({
              week: z.number().int(),
              points: z.number(),
              vsAverage: z
                .number()
                .describe('Points above (+) or below (-) his points per game this season.'),
              opponent: z
                .object({ team: z.string(), home: z.boolean() })
                .nullable()
                .describe('Who his team played that week; null when unknown.'),
              breakdown: z
                .array(
                  z.object({
                    stat: z.string().describe('The Sleeper stat key, or "other" for the small rest.'),
                    text: z
                      .string()
                      .describe('What he did, e.g. "82 rec yds", "1 rec TD", or "rec yd bonus".'),
                    points: z.number().describe('Points that earned (negative for a penalty).')
                  })
                )
                .describe(
                  'Where the game’s points came from under the caller’s scoring: biggest earners first, penalties last, the small rest as `other`.'
                )
            })
          )
          .describe('His last three games played, newest first, each in detail.')
      })
      .nullable()
      .describe(
        'This regular season so far, from the ingested weekly stats; null before his first stat line.'
      ),
    nextWeek: z
      .object({
        season: z.number().int(),
        week: z.number().int().describe('The current NFL week: the one being played, or about to be.'),
        points: z
          .number()
          .nullable()
          .describe('Projected fantasy points, or null before projections are out.'),
        totals: TotalsSchema.describe('Projected stat totals for the week; empty when unprojected.'),
        bye: z.boolean().describe('True when his NFL team has no game this week.'),
        opponent: z
          .object({ team: z.string().describe('The opposing NFL team, e.g. "BUF".'), home: z.boolean() })
          .nullable(),
        kickoff: z.string().nullable().describe('Kickoff (ISO 8601), or null on a bye or unknown.')
      })
      .nullable()
      .describe('The upcoming week: projection and matchup. Null in the offseason.'),
    news: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          source: z.string(),
          publishedAt: z.string()
        })
      )
      .describe('Up to 3 recent headlines naming him, newest first (get_news has more).')
  }),
  handler: async (ctx, input) => {
    const scoring = await scoringFor(ctx, input.leagueId);
    const player = await ctx.data.players.resolve(input);
    const [research, news, form] = await Promise.all([
      loadResearch(ctx, scoring.settings, [player.id]),
      ctx.data.reference.news.listByPlayer(player.id, { limit: CARD_NEWS_LIMIT }),
      loadCurrentForm(ctx, scoring.settings, player)
    ]);
    const last = research.lastSeason(player.id);
    const projection = research.projection(player.id);
    return {
      player: toPlayerDetail(player, true),
      scoring: { source: scoring.source },
      bye: research.bye(player.team),
      injuryStatus: player.injuryStatus,
      lastSeason:
        last === null
          ? null
          : {
              season: last.season,
              points: last.points,
              ppg: last.ppg,
              games: last.games,
              weekly: last.weekly,
              totals: cardTotals(last.lines, player.position)
            },
      projection:
        projection === null
          ? null
          : {
              season: projection.season,
              points: projection.points,
              totals: cardTotals(projection.lines, player.position)
            },
      thisSeason: form.thisSeason,
      nextWeek: form.nextWeek,
      news: news.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt
      }))
    };
  }
});
