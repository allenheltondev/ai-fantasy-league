import { z } from 'zod';
import {
  actorTeam,
  leagueAllowedActions,
  nextLineupLock,
  phaseFlags,
  type ActionOperation
} from './phase.js';
import type { LeagueAccess } from './access.js';
import { LeagueSettingsSchema } from '@fantasy/core';
import {
  FlagsSchema,
  PhaseSchema,
  TeamDetailSchema,
  teamDetail,
  TeamSummarySchema,
  teamSummary
} from './views.js';

export const LeagueStateSchema = z.object({
  leagueId: z.string(),
  name: z.string(),
  season: z.number().int(),
  phase: PhaseSchema,
  week: z.number().int().nullable().describe('Current NFL week, or null before the season.'),
  flags: FlagsSchema,
  youAreCommissioner: z.boolean(),
  yourTeam: TeamDetailSchema.nullable().describe('The team you manage, or null if you have none.'),
  allowedActions: z
    .array(z.string())
    .describe('League operations you may call right now. Anything else will be refused.'),
  deadlines: z.object({
    startWeek: z.number().int().describe('First NFL week this league plays.'),
    regularSeasonEndWeek: z.number().int(),
    playoffWeeks: z.array(z.number().int()),
    tradeDeadlineWeek: z.number().int().describe('No trades process once this week kicks off.'),
    tradeDeadlineAt: z.string().nullable(),
    draftStartsAt: z.string().nullable().describe('When the draft started (once it has).'),
    draftScheduledAt: z
      .string()
      .nullable()
      .describe(
        'Before the draft: when it starts by itself (`settings.draft.scheduledAt`), or null if the commissioner starts it by hand.'
      ),
    nextLineupLockAt: z.string().nullable(),
    nextWaiverRunAt: z.string().nullable()
  }),
  teams: z.array(
    TeamSummarySchema.extend({
      faabRemaining: z.number().optional().describe('FAAB left. Present when `detail` is true.'),
      waiverPriority: z.number().int().optional().describe('Waiver priority. Present when `detail` is true.'),
      rosterSize: z.number().int().optional().describe('Players rostered. Present when `detail` is true.')
    })
  ),
  settings: LeagueSettingsSchema.optional().describe(
    'The league’s rule settings. Present when `detail` is true.'
  )
});

export function leagueState(
  access: LeagueAccess,
  operations: readonly ActionOperation[],
  now: Date,
  detail = false
): z.infer<typeof LeagueStateSchema> {
  const { league, teams, actor } = access;
  const yourTeam = actorTeam(actor);
  return {
    leagueId: league.id,
    name: league.name,
    season: league.season,
    phase: league.phase,
    week: league.week,
    flags: phaseFlags(league, now),
    youAreCommissioner: actor.kind === 'user' && actor.isCommissioner,
    yourTeam: yourTeam === null ? null : teamDetail(yourTeam),
    allowedActions: leagueAllowedActions(operations, league, actor, now),
    deadlines: {
      startWeek: league.settings.schedule.startWeek,
      regularSeasonEndWeek: league.settings.schedule.regularSeasonEndWeek,
      playoffWeeks: weekRange(league.settings.playoffs.startWeek, league.settings.playoffs.endWeek),
      tradeDeadlineWeek: league.settings.trades.deadlineWeek,
      tradeDeadlineAt: league.deadlines.tradeDeadlineAt,
      draftStartsAt: league.deadlines.draftStartsAt,
      draftScheduledAt: league.phase === 'setup' ? league.settings.draft.scheduledAt : null,
      nextLineupLockAt: nextLineupLock(league, now),
      nextWaiverRunAt: league.deadlines.nextWaiverRunAt
    },
    teams: teams.map((team) =>
      detail
        ? {
            ...teamSummary(team),
            faabRemaining: team.faabRemaining,
            waiverPriority: team.waiverPriority,
            rosterSize: team.roster.length
          }
        : teamSummary(team)
    ),
    ...(detail ? { settings: league.settings } : {})
  };
}

function weekRange(from: number, to: number): number[] {
  const weeks: number[] = [];
  for (let week = from; week <= to; week++) weeks.push(week);
  return weeks;
}
