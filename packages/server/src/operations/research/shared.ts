import { LAST_NFL_WEEK, ScoringSettingsSchema, scoringPreset, type ScoringSettings } from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { ApiError } from '../../errors.js';
import type { Position } from '../../players/model.js';

export const seasonField = z
  .number()
  .int()
  .min(2000)
  .max(2100)
  .optional()
  .describe('NFL season year, e.g. 2026. Defaults to the current season.');

export const weekField = z
  .number()
  .int()
  .min(1)
  .max(LAST_NFL_WEEK)
  .optional()
  .describe('Regular-season week (1-18). Defaults to the current NFL week.');

export const leagueIdField = z
  .string()
  .min(1)
  .optional()
  .describe('Your league id. Pass it to score projections with that league’s scoring settings.');

/** The season and week to read: the caller's, else the stored NFL state's. */
export async function resolveWeek(
  ctx: Ctx,
  input: { season?: number | undefined; week?: number | undefined }
): Promise<{ season: number; week: number }> {
  if (input.season !== undefined && input.week !== undefined)
    return { season: input.season, week: input.week };
  const state = await ctx.data.reference.nflState.get();
  if (state === null) {
    throw new ApiError('NOT_FOUND', 'The current NFL week is not known yet.', {
      fix: 'Pass both `season` and `week` explicitly, e.g. season 2026 and week 5.'
    });
  }
  const current = state.seasonType === 'pre' ? { season: state.leagueSeason, week: 1 } : state;
  return {
    season: input.season ?? current.season,
    week: input.week ?? Math.min(Math.max(current.week, 1), LAST_NFL_WEEK)
  };
}

export interface ScoringChoice {
  settings: ScoringSettings;
  source: 'league' | 'default';
}

/** Anything league-shaped that carries scoring settings (`settings.scoring`). */
const LeagueScoringSchema = z.object({ settings: z.object({ scoring: ScoringSettingsSchema }) });

/**
 * The scoring to project with: the league's own settings when it has them, else the Yahoo
 * standard half-PPR default every league starts from (SPEC §10).
 */
export async function scoringFor(ctx: Ctx, leagueId: string | undefined): Promise<ScoringChoice> {
  if (leagueId === undefined) return { settings: scoringPreset('yahoo_standard'), source: 'default' };
  const league = await ctx.repos.leagues.get(leagueId);
  if (league === null) {
    throw new ApiError('LEAGUE_NOT_FOUND', `League "${leagueId}" does not exist.`, {
      fix: 'Check the leagueId, or omit it to use default (Yahoo standard half-PPR) scoring.'
    });
  }
  const parsed = LeagueScoringSchema.safeParse(league);
  return parsed.success
    ? { settings: parsed.data.settings.scoring, source: 'league' }
    : { settings: scoringPreset('yahoo_standard'), source: 'default' };
}

/** The handful of stats that matter per position, for compact responses. */
export const KEY_STATS: Readonly<Record<Position, readonly string[]>> = {
  QB: ['pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td'],
  RB: ['rush_att', 'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td'],
  WR: ['rec_tgt', 'rec', 'rec_yd', 'rec_td', 'rush_yd'],
  TE: ['rec_tgt', 'rec', 'rec_yd', 'rec_td'],
  K: ['fgm', 'fga', 'xpm'],
  DEF: ['sack', 'int', 'fum_rec', 'def_td', 'pts_allow']
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Key stats for the position (compact), or every stat (detail), rounded to one decimal. */
export function pickStats(
  stats: Readonly<Record<string, number>>,
  position: Position,
  detail: boolean
): Record<string, number> {
  const keys = detail ? Object.keys(stats).sort() : KEY_STATS[position];
  const out: Record<string, number> = {};
  for (const key of keys) {
    const value = stats[key];
    if (value !== undefined && (detail || value !== 0)) out[key] = round1(value);
  }
  return out;
}
