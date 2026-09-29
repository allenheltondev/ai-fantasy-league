import { LeagueSettingsSchema, NAME_SET_BY, leagueWeeks } from '@fantasy/core';
import { z } from 'zod';
import {
  LEAGUE_PHASES,
  SEAT_TYPES,
  type Invite,
  type League,
  type Matchup,
  type Team
} from '../repos/types.js';
import { TeamManagerSchema, teamManager, type ManagerLookup } from './managers.js';
import { isOpenSeat, renamedFrom, teamNameSetBy } from './seats.js';

/** Output shapes shared by the league operations, and the mappers that build them. */

export const LeagueIdSchema = z.string().min(1).max(64).describe('League id.');
export const TeamIdSchema = z.string().min(1).max(64).describe('Team id, e.g. "team-3".');
export const TeamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'Team names cannot contain line breaks or control characters.')
  .describe('Team name, 1-40 characters on one line (no control characters), unique in the league.');

export const PhaseSchema = z
  .enum(LEAGUE_PHASES)
  .describe('setup → drafting → regular_season → playoffs → complete.');

export const FlagsSchema = z
  .object({
    waiversOpen: z.boolean().describe('Waiver claims and free-agent adds are accepted.'),
    preLock: z
      .boolean()
      .describe("Some of this week's games have not kicked off: those players can still change slots."),
    tradeDeadlinePassed: z.boolean().describe('No more trades can process this season.')
  })
  .describe('Sub-phase conditions that decide which in-season actions are open.');

export const TeamSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  seatType: z
    .enum(SEAT_TYPES)
    .describe('`human`: a person plays it (or it is kept open for one). `agent`: an AI plays it.'),
  open: z.boolean().describe('True when no person holds this seat, so someone joining could take it.'),
  ownerName: z.string().nullable(),
  draftSlot: z.number().int(),
  avatarSeed: z
    .string()
    .nullable()
    .describe(
      "Seed for the team's own avatar picture, set by its owner with rename_team; null until set. An AI manager's avatar is `manager.avatarSeed`."
    ),
  manager: TeamManagerSchema.optional().describe(
    'The AI manager playing this team (name, avatar seed, personality); null when a person plays it. Present in league listings (get_league, get_league_state, create_league).'
  ),
  nameSetBy: z
    .enum(NAME_SET_BY)
    .describe(
      "Who set the name: `owner` (the person who holds it), `commissioner` (locked: an AI manager never changes it), `agent` (its AI manager named it), or `default` (the seat's own name, which its AI manager may replace)."
    ),
  renamedFrom: z
    .string()
    .nullable()
    .describe('The name the team had before its last rename, e.g. "Team 3"; null if it was never renamed.')
});

export const TeamDetailSchema = TeamSummarySchema.extend({
  ownerUserId: z
    .string()
    .nullable()
    .describe("The owner's user id; pass it to transfer_commissioner or remove_member."),
  agentConfigId: z.string().nullable(),
  faabRemaining: z.number(),
  waiverPriority: z.number().int(),
  rosterSize: z.number().int()
});

/** Pass `managers` (league/managers.ts) to include each team's AI manager. */
export function teamSummary(team: Team, managers?: ManagerLookup): z.infer<typeof TeamSummarySchema> {
  return {
    id: team.id,
    name: team.name,
    seatType: team.seatType,
    open: isOpenSeat(team),
    ownerName: team.ownerName,
    draftSlot: team.draftSlot,
    avatarSeed: team.avatarSeed ?? null,
    nameSetBy: teamNameSetBy(team),
    renamedFrom: renamedFrom(team),
    ...(managers === undefined ? {} : { manager: teamManager(managers, team.id) })
  };
}

export function teamDetail(team: Team, managers?: ManagerLookup): z.infer<typeof TeamDetailSchema> {
  return {
    ...teamSummary(team, managers),
    ownerUserId: team.ownerUserId,
    agentConfigId: team.agentConfigId,
    faabRemaining: team.faabRemaining,
    waiverPriority: team.waiverPriority,
    rosterSize: team.roster.length
  };
}

export const WeeksSchema = z
  .object({
    startWeek: z.number().int(),
    regularSeason: z.array(z.number().int()),
    playoffs: z.array(z.number().int()),
    tradeDeadlineWeek: z.number().int(),
    midSeasonStart: z.boolean().describe('True when the league starts after NFL week 1.')
  })
  .describe('The NFL weeks this league plays.');

export function leagueWeeksView(league: League): z.infer<typeof WeeksSchema> | null {
  const weeks = leagueWeeks(league.settings);
  return weeks.ok ? weeks.value : null;
}

export const LeagueSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  season: z.number().int(),
  phase: PhaseSchema,
  week: z.number().int().nullable(),
  teamCount: z.number().int(),
  startWeek: z.number().int(),
  commissionerName: z.string(),
  youAreCommissioner: z.boolean(),
  yourTeamId: z.string().nullable()
});

export function leagueSummary(
  league: League,
  userId: string,
  teamId: string | null
): z.infer<typeof LeagueSummarySchema> {
  return {
    id: league.id,
    name: league.name,
    season: league.season,
    phase: league.phase,
    week: league.week,
    teamCount: league.settings.teamCount,
    startWeek: league.settings.schedule.startWeek,
    commissionerName: league.commissionerName,
    youAreCommissioner: league.commissionerId === userId,
    yourTeamId: teamId
  };
}

export const LeagueDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  season: z.number().int(),
  phase: PhaseSchema,
  week: z.number().int().nullable(),
  version: z.number().int().describe('Pass as expectedVersion to update_league_settings.'),
  commissioner: z.object({ userId: z.string(), name: z.string() }),
  settings: LeagueSettingsSchema,
  weeks: WeeksSchema.nullable(),
  teams: z.array(TeamDetailSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

export function leagueDetail(
  league: League,
  teams: readonly Team[],
  managers?: ManagerLookup
): z.infer<typeof LeagueDetailSchema> {
  return {
    id: league.id,
    name: league.name,
    season: league.season,
    phase: league.phase,
    week: league.week,
    version: league.version,
    commissioner: { userId: league.commissionerId, name: league.commissionerName },
    settings: league.settings,
    weeks: leagueWeeksView(league),
    teams: teams.map((t) => teamDetail(t, managers)),
    createdAt: league.createdAt,
    updatedAt: league.updatedAt
  };
}

export const INVITE_STATUSES = ['active', 'expired', 'used_up', 'revoked'] as const;

export function inviteStatus(invite: Invite, now: Date): (typeof INVITE_STATUSES)[number] {
  if (invite.revokedAt !== null) return 'revoked';
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return 'expired';
  if (invite.uses >= invite.maxUses) return 'used_up';
  return 'active';
}

export const InviteViewSchema = z.object({
  id: z.string(),
  status: z.enum(INVITE_STATUSES),
  email: z
    .string()
    .nullable()
    .describe('Only this email can use the invite; null means anyone with the link.'),
  maxUses: z.number().int(),
  uses: z.number().int(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
});

export function inviteView(invite: Invite, now: Date): z.infer<typeof InviteViewSchema> {
  return {
    id: invite.id,
    status: inviteStatus(invite, now),
    email: invite.email,
    maxUses: invite.maxUses,
    uses: invite.uses,
    expiresAt: invite.expiresAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt
  };
}

export const MatchupSideSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  score: z.number().nullable().describe('Null until the week is scored.'),
  manager: TeamManagerSchema.optional()
});

export const MatchupViewSchema = z.object({
  id: z.string(),
  week: z.number().int(),
  kind: z.enum(['regular', 'playoff']),
  status: z.enum(['scheduled', 'in_progress', 'final']),
  home: MatchupSideSchema,
  away: MatchupSideSchema
});

export function matchupView(
  m: Matchup,
  teams: readonly Team[],
  managers?: ManagerLookup
): z.infer<typeof MatchupViewSchema> {
  const name = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const manager = (id: string) => (managers === undefined ? {} : { manager: teamManager(managers, id) });
  return {
    id: m.id,
    week: m.week,
    kind: m.kind,
    status: m.status,
    home: {
      teamId: m.homeTeamId,
      teamName: name(m.homeTeamId),
      score: m.homeScore,
      ...manager(m.homeTeamId)
    },
    away: { teamId: m.awayTeamId, teamName: name(m.awayTeamId), score: m.awayScore, ...manager(m.awayTeamId) }
  };
}
