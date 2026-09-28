import { ApiError } from '../../errors.js';
import { hashInviteToken, isWellFormedInviteToken } from '../../league/tokens.js';
import { inviteStatus } from '../../league/views.js';
import type { Invite, League, Repos } from '../../repos/types.js';

/** Shared by get_invite and join_league: find an invite by its token and check it can be used. */

/** The invite and its league; INVITE_NOT_FOUND when either is gone (a deleted league takes its invites). */
export async function findInvite(repos: Repos, token: string): Promise<{ invite: Invite; league: League }> {
  const invite = isWellFormedInviteToken(token)
    ? await repos.invites.getByTokenHash(hashInviteToken(token))
    : null;
  const league = invite === null ? null : await repos.leagues.get(invite.leagueId);
  if (invite === null || league === null) {
    throw new ApiError('INVITE_NOT_FOUND', 'This invite link is not valid.', {
      fix: 'Check that the whole link was copied. If it still fails, ask the commissioner for a new invite link.'
    });
  }
  return { invite, league };
}

export function assertUsable(invite: Invite, now: Date): void {
  switch (inviteStatus(invite, now)) {
    case 'revoked':
      throw new ApiError('INVITE_REVOKED', 'The commissioner revoked this invite.', {
        fix: 'Ask the commissioner for a new invite link.'
      });
    case 'expired':
      throw new ApiError('INVITE_EXPIRED', `This invite expired at ${invite.expiresAt}.`, {
        fix: 'Ask the commissioner for a new invite link.'
      });
    case 'used_up':
      throw new ApiError('INVITE_USED_UP', 'This invite has already been used as many times as allowed.', {
        fix: 'Ask the commissioner for a new invite link, or one with more uses.'
      });
    case 'active':
      return;
  }
}
