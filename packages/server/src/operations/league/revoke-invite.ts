import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireCommissioner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { inviteView, InviteViewSchema, LeagueIdSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';

export const revokeInvite = defineOperation({
  name: 'revoke_invite',
  method: 'DELETE',
  path: '/leagues/{leagueId}/invites/{inviteId}',
  summary: 'Revoke an invite so its link stops working (commissioner only)',
  description: [
    'Revokes an invite: its link stops working immediately, and anyone trying it gets INVITE_REVOKED. People who already joined keep their seats (use remove_member for that).',
    'Revoking an invite that is already revoked succeeds and changes nothing. Get invite ids from list_invites. Only the commissioner can revoke, while the league is in setup.'
  ].join(' '),
  tags: ['leagues', 'invites'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    inviteId: z.string().min(1).max(64).describe('Invite id from list_invites or create_invite.')
  }),
  output: z.object({ invite: InviteViewSchema }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('revoke_invite', access.league, access.actor, now);
    const invite = await ctx.repos.invites.get(input.leagueId, input.inviteId);
    if (invite === null) {
      throw new ApiError('INVITE_NOT_FOUND', `Invite "${input.inviteId}" is not in this league.`, {
        fix: 'Use an invite id from list_invites.'
      });
    }
    if (invite.revokedAt !== null) return { invite: inviteView(invite, now) };
    const revoked = await ctx.repos.invites.update({ ...invite, revokedAt: now.toISOString() });
    return { invite: inviteView(revoked, now) };
  }
});
