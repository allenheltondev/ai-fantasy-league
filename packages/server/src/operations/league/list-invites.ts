import { z } from 'zod';
import { requireCommissioner } from '../../league/access.js';
import { inviteView, InviteViewSchema, LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const listInvites = defineOperation({
  name: 'list_invites',
  method: 'GET',
  path: '/leagues/{leagueId}/invites',
  summary: "List the league's invites (commissioner only)",
  description: [
    'Returns every invite for the league, newest first, with its status (active, expired, used_up, revoked), uses, and expiry. Tokens are never returned: they are shown only once, by create_invite.',
    'Use an invite `id` with revoke_invite. Only the commissioner can list invites.'
  ].join(' '),
  tags: ['leagues', 'invites'],
  mutation: false,
  auth: 'user',
  input: z.object({ leagueId: LeagueIdSchema }),
  output: z.object({ invites: z.array(InviteViewSchema) }),
  handler: async (ctx, input) => {
    await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    const invites = await ctx.repos.invites.list(input.leagueId);
    return { invites: invites.map((invite) => inviteView(invite, now)) };
  }
});
