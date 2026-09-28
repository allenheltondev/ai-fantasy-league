import { LAST_NFL_WEEK } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema, TeamIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings } from '../../registry/operation.js';
import { matchupScoringLog, pageScoringLog, ScoringLogEntrySchema } from '../../season/scoring-log.js';
import { findMatchup } from './get-matchup.js';

export const getScoringLog = defineOperation({
  name: 'get_scoring_log',
  method: 'GET',
  path: '/leagues/{leagueId}/matchup/scoring-log',
  summary: "A matchup's scoring log: every scoring change for both lineups, newest first",
  description: [
    'Returns a team\'s matchup scoring log for a week, newest first: each time a player in either lineup gained or lost points, with the time, the fantasy team, the player, the stats that changed (e.g. "+1 rec, +18 rec yds, +1 rec TD"), and the points under this league\'s scoring.',
    "Stat corrections from the official final show as `kind: correction` entries, often with negative points. A player's entries add up to his points for the week.",
    'Touchdowns and made field goals carry the play as ESPN describes it (`play.text`, e.g. "Travis Kelce 18 Yd pass from Patrick Mahomes (Harrison Butker Kick)") when exactly one play fits; otherwise `play` is null, so a null play says nothing about what happened.',
    'Defaults: your own team, the current week, and starters only (`includeBench: true` adds bench players, marked `starter: false`). Pass `teamId` for any team in the league and `week` for any week the league plays.',
    'Page with `cursor` (from `nextCursor`). The log fills from live stats while games are played; weeks played before the log existed have no entries. Only members can read it.',
    'For the scores and lineups themselves use get_matchup.'
  ].join(' '),
  tags: ['leagues', 'season'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema.optional().describe('Team whose matchup to read (default: your own team).'),
    week: z
      .number()
      .int()
      .min(1)
      .max(LAST_NFL_WEEK)
      .optional()
      .describe('NFL week (default: the current week).'),
    includeBench: z
      .boolean()
      .default(false)
      .describe('Include bench players, whose points do not count (default false: starters only).'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum entries (1-100, default 25).'),
    cursor: z.string().min(1).max(200).optional().describe('`nextCursor` from the previous page.')
  }),
  output: z.object({
    week: z.number().int(),
    teamId: z.string(),
    matchupId: z.string().nullable().describe('The matchup, or null when the team has no game that week.'),
    entries: z.array(ScoringLogEntrySchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for older entries; null on the last page.')
  }),
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league, teams } = access;
    const { team, week, matchup } = await findMatchup(ctx, access, input);
    if (matchup === undefined) {
      return withWarnings({ week, teamId: team.id, matchupId: null, entries: [], nextCursor: null }, [
        league.phase === 'setup' || league.phase === 'drafting'
          ? { code: 'NO_SCHEDULE_YET', message: 'The schedule is created when the draft starts.' }
          : { code: 'NO_MATCHUP', message: `${team.name} has no game in week ${week}.` }
      ]);
    }
    const log = await matchupScoringLog(
      { repos: ctx.repos, reference: ctx.data.reference },
      league,
      teams,
      matchup,
      ctx.clock.now(),
      { includeBench: input.includeBench }
    );
    const page = pageScoringLog(log, input.limit, input.cursor);
    return { week, teamId: team.id, matchupId: matchup.id, ...page };
  }
});
