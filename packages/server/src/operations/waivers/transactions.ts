import { z } from 'zod';
import { requireMember } from '../../league/access.js';
import { LeagueIdSchema } from '../../league/views.js';
import { PlayerRefSchema } from '../../players/model.js';
import { defineOperation } from '../../registry/operation.js';
import { TRANSACTION_TYPES } from '../../repos/waivers.js';
import { playerRefs, refOf } from './shared.js';

export const listTransactions = defineOperation({
  name: 'list_transactions',
  method: 'GET',
  path: '/leagues/{leagueId}/transactions',
  summary: 'The league transaction log: adds, drops, and waiver awards',
  description:
    'Lists roster moves in the league, newest first: free-agent adds (`add`, with any player dropped in the same move), releases (`drop`), and waiver claims awarded by a waiver run (`waiver_claim`, with the FAAB paid). Page with `cursor` (from `nextCursor`). Any member can read it.',
  tags: ['waivers'],
  mutation: false,
  input: z.object({
    leagueId: LeagueIdSchema,
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum moves (1-100, default 25).'),
    cursor: z.string().min(1).max(200).optional().describe('`nextCursor` from the previous page.')
  }),
  output: z.object({
    transactions: z.array(
      z.object({
        id: z.string(),
        at: z.string(),
        week: z.number().int(),
        type: z.enum(TRANSACTION_TYPES),
        teamId: z.string(),
        teamName: z.string(),
        added: PlayerRefSchema.nullable(),
        dropped: PlayerRefSchema.nullable(),
        cost: z.number().int().nullable().describe('FAAB paid (waiver claims).')
      })
    ),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for older moves; null on the last page.')
  }),
  handler: async (ctx, input) => {
    const { league, teams } = await requireMember(ctx, input.leagueId);
    const page = await ctx.repos.waivers.listTransactions(league.id, {
      limit: input.limit,
      cursor: input.cursor ?? null
    });
    const refs = await playerRefs(
      ctx,
      page.items.flatMap((t) => [t.addPlayerId, t.dropPlayerId])
    );
    return {
      transactions: page.items.map((t) => ({
        id: t.id,
        at: t.at,
        week: t.week,
        type: t.type,
        teamId: t.teamId,
        teamName: teams.find((team) => team.id === t.teamId)?.name ?? t.teamId,
        added: t.addPlayerId === null ? null : refOf(refs, t.addPlayerId),
        dropped: t.dropPlayerId === null ? null : refOf(refs, t.dropPlayerId),
        cost: t.cost
      })),
      nextCursor: page.nextCursor
    };
  }
});
