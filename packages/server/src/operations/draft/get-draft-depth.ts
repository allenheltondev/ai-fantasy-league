import {
  currentPick,
  pickSlot,
  picksUntilTurn,
  starterSlotFill,
  teamPicks,
  type DraftState,
  type LeagueSettings
} from '@fantasy/core';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { requireMember } from '../../league/access.js';
import { requireDraft } from '../../league/draft.js';
import { actorTeam } from '../../league/phase.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema, POSITIONS, toPlayerRef, type Position } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import type { Team } from '../../repos/types.js';

const TeamDepthSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  yours: z.boolean().describe('True for your own team (listed first).'),
  picksBeforeYou: z
    .number()
    .int()
    .describe('Picks this team makes before your next turn (0 when none, or you have no pick left).'),
  positions: z
    .array(
      z.object({
        position: z.enum(POSITIONS),
        players: z.array(PlayerRefSchema).describe('Drafted players at the position, in pick order.')
      })
    )
    .describe('Every fantasy position, with the players drafted there (possibly none).'),
  slots: z
    .array(
      z.object({
        slot: z.string().describe('Starting slot, e.g. "RB" or the flex "W/R/T".'),
        required: z.number().int(),
        filled: z.number().int()
      })
    )
    .describe('Each starting slot the league uses and how many are filled, e.g. RB 1 of 2.'),
  gaps: z.array(z.string()).describe('Starting slots still empty, one entry per open slot.')
});

export const DraftDepthSchema = z.object({
  yourTeamId: z.string().nullable(),
  teams: z.array(TeamDepthSchema).describe('Your team first, then the rest in round-1 order.')
});
export type DraftDepth = z.infer<typeof DraftDepthSchema>;

/** How many picks each team makes from the pick on the clock up to (not including) your next one. */
export function picksBeforeTurn(state: DraftState, yourTeamId: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  const now = currentPick(state);
  const away = yourTeamId === null ? null : picksUntilTurn(state, yourTeamId);
  if (now === null || away === null) return counts;
  for (let overall = now.overall; overall < now.overall + away; overall++) {
    const slot = pickSlot(state, overall);
    if (slot !== null) counts.set(slot.teamId, (counts.get(slot.teamId) ?? 0) + 1);
  }
  return counts;
}

export async function buildDepth(
  ctx: Pick<Ctx, 'data'>,
  input: { state: DraftState; teams: readonly Team[]; settings: LeagueSettings; yourTeamId: string | null }
): Promise<DraftDepth> {
  const { state, yourTeamId } = input;
  const players = new Map((await ctx.data.players.all()).map((p) => [p.id, p]));
  const before = picksBeforeTurn(state, yourTeamId);
  const ordered = [
    ...state.teamIds.filter((id) => id === yourTeamId),
    ...state.teamIds.filter((id) => id !== yourTeamId)
  ];
  return {
    yourTeamId,
    teams: ordered.map((teamId) => {
      const picks = teamPicks(state, teamId);
      const refs = picks.map((p) => {
        const player = players.get(p.playerId);
        return player === undefined
          ? { id: p.playerId, name: p.playerId, team: null, position: p.positions[0] as Position }
          : toPlayerRef(player);
      });
      const slots = starterSlotFill(
        input.settings,
        picks.map((p) => p.positions)
      );
      return {
        teamId,
        teamName: input.teams.find((t) => t.id === teamId)?.name ?? teamId,
        yours: teamId === yourTeamId,
        picksBeforeYou: before.get(teamId) ?? 0,
        positions: POSITIONS.map((position) => ({
          position,
          players: refs.filter((r) => r.position === position)
        })),
        slots,
        gaps: slots.flatMap((s) => Array.from({ length: s.required - s.filled }, () => s.slot))
      };
    })
  };
}

export const getDraftDepth = defineOperation({
  name: 'get_draft_depth',
  method: 'GET',
  path: '/leagues/{leagueId}/draft/depth',
  summary: "Every team's drafted roster by position, with starting slots filled and gaps",
  description: [
    'A depth view of the draft: for each team, its drafted players grouped by position, how many of each starting slot are filled (e.g. RB 1 of 2, W/R/T 0 of 1), and the gaps still open.',
    'Your team comes first. `picksBeforeYou` counts the picks each team makes before your next turn, so you can see which positions the teams ahead of you still need (a run on a position is coming when several of them share a gap).',
    'Before the draft starts this returns DRAFT_NOT_STARTED. Any member of the league can read it.'
  ].join(' '),
  tags: ['draft'],
  mutation: false,
  input: z.object({ leagueId: LeagueIdSchema }),
  output: DraftDepthSchema,
  handler: async (ctx, input) => {
    const access = await requireMember(ctx, input.leagueId);
    const record = requireDraft(await ctx.repos.drafts.get(input.leagueId));
    return buildDepth(ctx, {
      state: record.state,
      teams: access.teams,
      settings: access.league.settings,
      yourTeamId: actorTeam(access.actor)?.id ?? null
    });
  }
});
