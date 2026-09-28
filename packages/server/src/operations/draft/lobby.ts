import { DRAFT_ORDER_MODES } from '@fantasy/core';
import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { leagueManagers, teamManager, TeamManagerSchema } from '../../league/managers.js';
import { actionError, actorTeam, assertAction } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { SEAT_TYPES } from '../../repos/types.js';

/** A check-in counts as "here" for this long; the draft room checks in every 15 seconds. */
export const LOBBY_PRESENCE_SECONDS = 45;

const LobbyTeamSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  seatType: z.enum(SEAT_TYPES),
  manager: TeamManagerSchema,
  here: z.boolean().describe('In the draft room now. Agent seats are always here.'),
  lastSeenAt: z.string().nullable()
});

export const DraftLobbySchema = z.object({
  phase: z.enum(['setup', 'drafting']).describe('`drafting` once the draft has started: open the board.'),
  scheduledAt: z
    .string()
    .nullable()
    .describe('When the draft starts by itself; null when the commissioner starts it by hand.'),
  orderMode: z.enum(DRAFT_ORDER_MODES),
  serverTime: z.string().describe('The server clock now, for an accurate countdown.'),
  order: z
    .array(LobbyTeamSchema)
    .nullable()
    .describe('Round-1 order by draft slot; null when it will be shuffled at the start.'),
  teams: z.array(LobbyTeamSchema).describe('Every seat and whether its manager is in the draft room.'),
  commissionerHere: z.boolean(),
  canStart: z.boolean().describe('True when you may start the draft now (start_draft).')
});

export const checkInDraftLobby = defineOperation({
  name: 'check_in_draft_lobby',
  method: 'POST',
  path: '/leagues/{leagueId}/draft/lobby',
  summary: 'Check in to the draft room and see who else is there before the draft',
  description: [
    'Marks you as present in the draft room (for about 45 seconds) and returns the lobby: when the draft starts (`scheduledAt`, with `serverTime` for the countdown), the round-1 order when it is known, and which managers are here. Agent seats are always here.',
    'Call it every 15 seconds while the lobby is open. Once `phase` is `drafting`, read get_draft_board instead. Only members and the commissioner, before or during the draft.'
  ].join(' '),
  tags: ['draft'],
  mutation: true,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: DraftLobbySchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const { league, teams, actor } = access;
    const now = ctx.clock.now();
    assertAction('check_in_draft_lobby', league, actor, now);
    const own = actorTeam(actor);
    const commissioner = actor.kind === 'user' && actor.isCommissioner;
    await ctx.repos.drafts.checkIn(league.id, own?.id ?? 'commissioner', now.toISOString());
    if (commissioner && own !== null)
      await ctx.repos.drafts.checkIn(league.id, 'commissioner', now.toISOString());
    const seen = await ctx.repos.drafts.lobby(league.id);
    const recent = (key: string) => {
      const at = seen[key];
      return at !== undefined && now.getTime() - Date.parse(at) <= LOBBY_PRESENCE_SECONDS * 1000;
    };
    const managers = await leagueManagers(ctx, league.id, teams);
    const view = [...teams]
      .sort((a, b) => a.draftSlot - b.draftSlot)
      .map((team) => {
        const agent = team.seatType === 'agent' && team.ownerUserId === null;
        return {
          teamId: team.id,
          teamName: team.name,
          seatType: team.seatType,
          manager: teamManager(managers, team.id),
          here: agent || recent(team.id),
          lastSeenAt: seen[team.id] ?? null
        };
      });
    const { scheduledAt, orderMode } = league.settings.draft;
    return {
      // check_in_draft_lobby is only allowed in setup and drafting.
      phase: league.phase === 'drafting' ? ('drafting' as const) : ('setup' as const),
      scheduledAt: league.phase === 'setup' ? scheduledAt : null,
      orderMode,
      serverTime: now.toISOString(),
      order: orderMode === 'random' && league.phase === 'setup' ? null : view,
      teams: view,
      commissionerHere: recent('commissioner'),
      canStart: actionError('start_draft', league, actor, now) === null
    };
  }
});
