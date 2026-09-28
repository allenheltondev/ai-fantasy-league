import { LAST_NFL_WEEK } from '@fantasy/core';
import { z } from 'zod';
import { requireCommissioner } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { DATA_JOB_NAMES } from '../../jobs/runs.js';
import { POSITIONS, type Position } from '../../players/model.js';
import { researchSeasons } from '../../players/research.js';
import { defineOperation } from '../../registry/operation.js';
import type { JobRun, SeasonLinesMeta } from '../../repos/reference.js';

const SeasonSetSchema = z
  .object({
    season: z.number().int(),
    updatedAt: z.string().describe('When the set was last replaced.'),
    checkedAt: z
      .string()
      .nullable()
      .describe('When the source was last checked (null before the first check that found no change).'),
    players: z.number().int(),
    weeks: z.array(z.number().int()).describe('Weeks the source had lines for.')
  })
  .nullable();

const JobRunSchema = z.object({
  finishedAt: z.string(),
  status: z.enum(['ok', 'skipped', 'failed']),
  reason: z.string().nullable().describe('Why the run skipped, or the error of a failed run.'),
  summary: z.string().nullable().describe("The rest of the job's result as JSON (weeks stored, counts)."),
  durationMs: z.number()
});

export const DataStatusSchema = z.object({
  checkedAt: z.string(),
  nflState: z
    .object({
      season: z.number().int(),
      seasonType: z.enum(['pre', 'regular', 'post', 'off']),
      week: z.number().int(),
      leagueSeason: z.number().int(),
      updatedAt: z.string()
    })
    .nullable()
    .describe(
      "Sleeper's NFL state as the syncNflState job last stored it; null when it was never stored, which leaves projections and research empty."
    ),
  league: z.object({
    season: z.number().int(),
    week: z.number().int().nullable().describe("The league's current week; null before its season starts.")
  }),
  players: z.object({
    total: z.number().int(),
    byPosition: z.record(z.enum(POSITIONS), z.number().int())
  }),
  weeks: z
    .array(
      z.object({
        season: z.number().int(),
        week: z.number().int(),
        projections: z
          .object({ capturedAt: z.string(), count: z.number().int(), hash: z.string() })
          .nullable()
          .describe('The latest weekly projection snapshot (what rosters and matchups show); null if none.'),
        statLines: z.number().int().describe('Stored stat lines for the week.')
      })
    )
    .describe("The league's current week (its first week before the season) and the next one."),
  research: z.object({
    stats: SeasonSetSchema.describe(
      "Last season's weekly stats (the draft room's Pts and PPG); null if none."
    ),
    projections: SeasonSetSchema.describe("This season's projections (the draft room's Proj); null if none.")
  }),
  jobs: z
    .array(
      z.object({
        job: z.string(),
        latest: JobRunSchema.nullable().describe('The latest recorded run; null when none is recorded.'),
        lastOk: JobRunSchema.nullable().describe('The latest run that did its work.')
      })
    )
    .describe('Each scheduled data job. Runs are kept for 30 days.')
});

function seasonSet(meta: SeasonLinesMeta | null): z.infer<typeof SeasonSetSchema> {
  if (meta === null) return null;
  return {
    season: meta.season,
    updatedAt: meta.updatedAt,
    checkedAt: meta.checkedAt ?? null,
    players: meta.players,
    weeks: meta.weeks
  };
}

export const getDataStatus = defineOperation({
  name: 'get_data_status',
  method: 'GET',
  path: '/leagues/{leagueId}/data-status',
  summary: 'Check the NFL data behind projections and research',
  description: [
    'Commissioner only. A diagnostic of the reference data this league reads: the stored NFL state, the player universe (by position), the latest projection snapshot and stat line count for the league’s current and next week, the draft research sets (last season’s stats and this season’s projections), and each scheduled data job’s latest run and last successful run, with the reason a run skipped or the error it failed with.',
    'Use it when projections, last-season points, or scores look empty: a null NFL state, a job that keeps skipping, or a job with no recorded run points at the cause.',
    'Errors: FORBIDDEN if you are not the commissioner; LEAGUE_NOT_FOUND for an unknown league.'
  ].join(' '),
  tags: ['leagues'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: DataStatusSchema,
  handler: async (ctx, input) => {
    const { league } = await requireCommissioner(ctx, input.leagueId);
    const { reference } = ctx.data;
    const now = ctx.clock.now();
    const base = Math.min(league.week ?? league.settings.schedule.startWeek, LAST_NFL_WEEK);
    const weekNumbers = base < LAST_NFL_WEEK ? [base, base + 1] : [base];
    const [state, players, jobs, weeks] = await Promise.all([
      reference.nflState.get(),
      ctx.data.players.all(),
      reference.jobRuns.list(DATA_JOB_NAMES),
      Promise.all(
        weekNumbers.map(async (week) => {
          const [snapshot, lines] = await Promise.all([
            reference.projections.latestSnapshot(league.season, week, now),
            reference.stats.getWeek(league.season, week)
          ]);
          return {
            season: league.season,
            week,
            projections:
              snapshot === null
                ? null
                : { capturedAt: snapshot.capturedAt, count: snapshot.count, hash: snapshot.hash },
            statLines: lines.length
          };
        })
      )
    ]);
    // The seasons the draft room reads: the NFL state's, or the league's when none is stored.
    const seasons =
      state === null ? { season: league.season, lastSeason: league.season - 1 } : researchSeasons(state);
    const [stats, projections] = await Promise.all([
      reference.seasons.getMeta('stats', seasons.lastSeason),
      reference.seasons.getMeta('projections', seasons.season)
    ]);
    const byPosition = Object.fromEntries(POSITIONS.map((p) => [p, 0])) as Record<Position, number>;
    for (const player of players) byPosition[player.position] += 1;
    const run = (r: JobRun | null) => {
      if (r === null) return null;
      const { job: _job, ...rest } = r;
      return rest;
    };
    return {
      checkedAt: now.toISOString(),
      nflState:
        state === null
          ? null
          : {
              season: state.season,
              seasonType: state.seasonType,
              week: state.week,
              leagueSeason: state.leagueSeason,
              updatedAt: state.updatedAt
            },
      league: { season: league.season, week: league.week },
      players: { total: players.length, byPosition },
      weeks,
      research: { stats: seasonSet(stats), projections: seasonSet(projections) },
      jobs: jobs.map((j) => ({ job: j.job, latest: run(j.latest), lastOk: run(j.lastOk) }))
    };
  }
});
