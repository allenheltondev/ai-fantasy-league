import { z } from 'zod';
import {
  actorTeam,
  leagueAllowedActions,
  nextLineupLock,
  phaseFlags,
  type ActionOperation
} from './phase.js';
import type { LeagueAccess } from './access.js';
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
    draftStartsAt: z.string().nullable(),
    nextLineupLockAt: z.string().nullable(),
    nextWaiverRunAt: z.string().nullable()
  }),
  teams: z.array(TeamSummarySchema)
});

export function leagueState(
  access: LeagueAccess,
  operations: readonly ActionOperation[],
  now: Date
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
      nextLineupLockAt: nextLineupLock(league, now),
      nextWaiverRunAt: league.deadlines.nextWaiverRunAt
    },
    teams: teams.map(teamSummary)
  };
}

function weekRange(from: number, to: number): number[] {
  const weeks: number[] = [];
  for (let week = from; week <= to; week++) weeks.push(week);
  return weeks;
}
