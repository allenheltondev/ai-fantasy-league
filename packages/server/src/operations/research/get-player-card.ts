import { z } from 'zod';
import type { Ctx } from '../../context.js';
import {
  PlayerDetailSchema,
  PositionSchema,
  playerSelectorShape,
  toPlayerDetail,
  type Position
} from '../../players/model.js';
import { loadCurrentForm } from '../../players/current-form.js';
import { loadPointsAllowed } from '../../players/points-allowed.js';
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
    'Returns one player’s card: this season’s fantasy points so far, week by week, with points per game and key stat totals, plus his last three games in detail: points, versus his average, the opponent, and where the points came from (`thisSeason`, `thisSeason.recent`), and his usage from official stats: target and air yards share, WOPR, depth of target, and EPA (`thisSeason.usage`); his projection for the current NFL week with his opponent and how that defense has fared against his position, or his bye (`nextWeek`); last regular season’s points each week plus totals, points per game, and key stat totals; this season’s projected points and stat totals; his age, NFL experience, and jersey number (`bio`); his bye week, injury designation, and ESPN’s injury note; and up to 3 recent news headlines.',
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
    injuryNote: z
      .object({
        text: z.string().describe('ESPN’s note, e.g. "Jefferson (hamstring) is doubtful for Sunday."'),
        reportedAt: z.string().nullable().describe('When ESPN posted it (ISO 8601), or null.')
      })
      .nullable()
      .describe('ESPN’s injury report note on his designation, or null when there is none.'),
    bio: z.object({
      age: z.number().int().nullable().describe('Age in years, or null when unknown.'),
      yearsExp: z
        .number()
        .int()
        .nullable()
        .describe('Seasons in the NFL before this one: 0 is a rookie. Null when unknown.'),
      number: z.number().int().nullable().describe('Jersey number, or null when unknown.')
    }),
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
          .describe('His last three games played, newest first, each in detail.'),
        usage: z
          .object({
            games: z
              .number()
              .int()
              .describe('Official games counted (stat-corrected weeks, so it can trail `games`).'),
            throughWeek: z.number().int().describe('The last official week counted.'),
            targetShare: z
              .number()
              .nullable()
              .describe(
                'Average share of his team’s targets, as a fraction (0.25 = 25%); null with no targets.'
              ),
            airYardsShare: z
              .number()
              .nullable()
              .describe('Average share of his team’s air yards, as a fraction.'),
            wopr: z
              .number()
              .nullable()
              .describe(
                'Weighted opportunity rating: 1.5 × target share + 0.7 × air yards share. Higher is a bigger role.'
              ),
            aDot: z.number().nullable().describe('Average depth of target: air yards per target.'),
            yacPerReception: z.number().nullable().describe('Yards after the catch per reception.'),
            receivingEpa: z.number().nullable().describe('Receiving expected points added per game.'),
            rushingEpa: z.number().nullable().describe('Rushing expected points added per game.'),
            passingEpa: z.number().nullable().describe('Passing expected points added per game.'),
            cpoe: z
              .number()
              .nullable()
              .describe('Completion percentage over expected, in points, weighted by attempts.'),
            passingAdot: z.number().nullable().describe('Air yards per pass attempt.')
          })
          .nullable()
          .describe(
            'His usage and efficiency from nflverse’s official weekly stats (added when each week’s stats are corrected, the Thursday after); null before his first official week.'
          )
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
        kickoff: z.string().nullable().describe('Kickoff (ISO 8601), or null on a bye or unknown.'),
        matchup: z
          .object({
            position: PositionSchema,
            perGame: z
              .number()
              .describe('PPR fantasy points per game the opponent’s defense has allowed to his position.'),
            rank: z
              .number()
              .int()
              .describe(
                '1 allows the most points to his position (the easiest matchup) through `of` (the toughest).'
              ),
            of: z.number().int(),
            games: z.number().int().describe('Games the opponent’s defense has played that count.'),
            throughWeek: z.number().int().describe('The last completed week counted.')
          })
          .nullable()
          .describe(
            'How the opponent’s defense has fared against his position this season (get_points_allowed has every team); null on a bye or before week 2.'
          )
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
    const [research, news, form, synced] = await Promise.all([
      loadResearch(ctx, scoring.settings, [player.id]),
      ctx.data.reference.news.listByPlayer(player.id, { limit: CARD_NEWS_LIMIT }),
      loadCurrentForm(ctx, scoring.settings, player),
      // The bio is enrichment: a failed read leaves it unknown rather than failing the card.
      ctx.data.reference.playerSync.getMany([player.id]).catch((error: unknown) => {
        ctx.log.warn('player card bio unavailable', { playerId: player.id, error });
        return [];
      })
    ]);
    const source = synced[0]?.source;
    const next = form.nextWeek;
    const matchup =
      next === null || next.opponent === null
        ? null
        : await opponentMatchup(ctx, next.season, next.week, next.opponent.team, player.position);
    const last = research.lastSeason(player.id);
    const projection = research.projection(player.id);
    return {
      player: toPlayerDetail(player, true),
      scoring: { source: scoring.source },
      bye: research.bye(player.team),
      injuryStatus: player.injuryStatus,
      injuryNote: player.injuryNote ?? null,
      bio: {
        age: source?.age ?? null,
        yearsExp: source?.yearsExp ?? null,
        number: source?.number ?? null
      },
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
      nextWeek: next === null ? null : { ...next, matchup },
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

/**
 * How `opponent`'s defense has fared against `position` through the weeks before `week`. It is
 * enrichment: a failed read (any of the 32 defenses) is logged and the matchup is null, so the
 * rest of the card still loads.
 */
async function opponentMatchup(
  ctx: Pick<Ctx, 'data' | 'log'>,
  season: number,
  week: number,
  opponent: string,
  position: Position
) {
  const table = await loadPointsAllowed(ctx.data.reference.stats, season, week).catch((error: unknown) => {
    ctx.log.warn('player card matchup unavailable', { season, week, opponent, error });
    return null;
  });
  const entry = table?.teams.find((t) => t.team === opponent);
  if (table === null || entry === undefined) return null;
  return { position, ...entry.positions[position], games: entry.games, throughWeek: table.throughWeek };
}
