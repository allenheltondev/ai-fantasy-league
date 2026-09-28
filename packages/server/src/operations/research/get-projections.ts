import { scorePlayer } from '@fantasy/core';
import type { ProjectionLine } from '@fantasy/data';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import {
  NFL_TEAMS,
  PlayerRefSchema,
  PositionSchema,
  playerSelectorShape,
  toPlayerRef,
  type Player
} from '../../players/model.js';
import { defineOperation, withWarnings, type Warning } from '../../registry/operation.js';
import { detailFlag } from '../players.js';
import { leagueIdField, pickStats, resolveWeek, scoringFor, seasonField, weekField } from './shared.js';

const ProjectionSchema = z.object({
  player: PlayerRefSchema,
  points: z.number().describe('Projected fantasy points under the scoring named in `scoring`.'),
  stats: z
    .record(z.string(), z.number())
    .describe(
      'Projected stats by Sleeper stat key (pass_yd, rec, ...). Compact: the key stats for the position; detail: every stat.'
    )
});

export const getProjections = defineOperation({
  name: 'get_projections',
  method: 'GET',
  path: '/projections',
  summary: 'Projected fantasy points and key stats for a week',
  description: [
    'Returns weekly projections: projected fantasy points plus the key projected stats.',
    'Ask for specific players (`playerId`, `player` name, or up to 25 `playerIds`), or browse a `position` and/or `team`, best projection first.',
    'With no filters, returns the top projections at every position.',
    'Season and week default to the current NFL week. Pass `leagueId` to score with that league’s settings; otherwise points use Yahoo standard half-PPR, and `scoring.source` says which was used.',
    'Projections are refreshed hourly; `capturedAt` is when the numbers were pulled. Use this to compare start/sit options, rank waiver targets, or value trades.',
    'An empty list with a NO_PROJECTIONS warning means none are published for that week yet. Ambiguous names return AMBIGUOUS_PLAYER; retry with a candidate id.'
  ].join(' '),
  tags: ['research'],
  mutation: false,
  input: z.object({
    ...playerSelectorShape,
    playerIds: z.array(z.string().min(1)).max(25).optional().describe('Several player ids at once (max 25).'),
    position: PositionSchema.optional(),
    team: z.enum(NFL_TEAMS).optional().describe('Only players on this NFL team, e.g. "KC".'),
    season: seasonField,
    week: weekField,
    leagueId: leagueIdField,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum players returned (1-100, default 25).'),
    detail: detailFlag
  }),
  output: z.object({
    season: z.number().int(),
    week: z.number().int(),
    capturedAt: z
      .string()
      .nullable()
      .describe('When these projections were pulled (ISO 8601), or null if none exist.'),
    scoring: z.object({
      source: z
        .enum(['league', 'default'])
        .describe('`league`: the league’s settings. `default`: Yahoo standard half-PPR.')
    }),
    projections: z.array(ProjectionSchema).describe('Highest projected points first.')
  }),
  handler: async (ctx, input) => {
    const { season, week } = await resolveWeek(ctx, input);
    const scoring = await scoringFor(ctx, input.leagueId);
    const base = { season, week, scoring: { source: scoring.source } };

    const selected = await selectedPlayers(ctx, input);
    const snapshot = await ctx.data.reference.projections.latestSnapshot(season, week, ctx.clock.now());
    if (snapshot === null) {
      return withWarnings({ ...base, capturedAt: null, projections: [] }, [noProjections(season, week)]);
    }

    let pairs: { player: Player; line: ProjectionLine }[];
    if (selected !== null) {
      const lines = await ctx.data.reference.projections.getLines(
        snapshot,
        selected.map((p) => p.id)
      );
      const byId = new Map(lines.map((l) => [l.playerId, l]));
      pairs = selected.flatMap((player) => {
        const line = byId.get(player.id);
        return line === undefined ? [] : [{ player, line }];
      });
    } else {
      const [lines, index] = await Promise.all([
        ctx.data.reference.projections.getLines(snapshot),
        ctx.data.players.all()
      ]);
      const players = new Map(index.map((p) => [p.id, p]));
      pairs = lines.flatMap((line) => {
        const player = players.get(line.playerId);
        return player === undefined ? [] : [{ player, line }];
      });
    }

    const projections = pairs
      .filter(({ player }) => input.position === undefined || player.position === input.position)
      .filter(({ player }) => input.team === undefined || player.team === input.team)
      .map(({ player, line }) => ({
        player: toPlayerRef(player),
        points: scorePlayer(scoring.settings, line.stats).points,
        stats: pickStats(line.stats, player.position, input.detail)
      }))
      .sort((a, b) => b.points - a.points || a.player.name.localeCompare(b.player.name))
      .slice(0, input.limit);

    const warnings: Warning[] = [];
    if (selected !== null && projections.length < selected.length) {
      const missing = selected.filter((p) => !projections.some((row) => row.player.id === p.id));
      warnings.push({
        code: 'NO_PROJECTION_FOR_PLAYER',
        message: `No projection for ${missing.map((p) => p.name).join(', ')} in week ${week} (bye, inactive, or not projected).`
      });
    }
    return withWarnings({ ...base, capturedAt: snapshot.capturedAt, projections }, warnings);
  }
});

async function selectedPlayers(
  ctx: Ctx,
  input: { playerId?: string | undefined; player?: string | undefined; playerIds?: string[] | undefined }
): Promise<Player[] | null> {
  const players: Player[] = [];
  if (input.playerId !== undefined || input.player !== undefined) {
    players.push(await ctx.data.players.resolve(input));
  }
  if (input.playerIds !== undefined && input.playerIds.length > 0) {
    for (const id of input.playerIds) players.push(await ctx.data.players.resolve({ playerId: id }));
  }
  if (players.length === 0) return null;
  return [...new Map(players.map((p) => [p.id, p])).values()];
}

function noProjections(season: number, week: number): Warning {
  return {
    code: 'NO_PROJECTIONS',
    message: `No projections are stored for ${season} week ${week} yet. They are published during the week before; try the current week.`
  };
}
