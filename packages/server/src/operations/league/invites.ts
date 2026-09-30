import { ApiError } from '../../errors.js';
import type { Ctx } from '../../context.js';
import { hashInviteToken, isWellFormedInviteToken, parseInviteCode } from '../../league/tokens.js';
import { inviteStatus } from '../../league/views.js';
import type { Invite, League } from '../../repos/types.js';

/** Shared by get_invite and join_league: find an invite by its token or join code and check it can be used. */

/** Join-code lookups a person can make in one clock hour (a lookup that finds its invite is free). */
export const MAX_CODE_ATTEMPTS_PER_HOUR = 10;

/**
 * The invite and its league; INVITE_NOT_FOUND when either is gone (a deleted league takes its
 * invites). `tokenOrCode` is the secret from an invite link or a join code typed by hand. Codes are
 * short enough to guess, so looking one up needs a signed-in person, and each lookup is reserved
 * (atomically, before it runs) against `MAX_CODE_ATTEMPTS_PER_HOUR`: once they are used up, further
 * lookups get RATE_LIMITED. A lookup that finds its invite gives its attempt back, so only misses
 * stay counted.
 */
export async function findInvite(
  ctx: Pick<Ctx, 'repos' | 'principal' | 'clock'>,
  tokenOrCode: string
): Promise<{ invite: Invite; league: League }> {
  const code = parseInviteCode(tokenOrCode);
  const attempt = code === null ? null : await reserveCodeAttempt(ctx);
  const invite =
    code !== null
      ? await ctx.repos.invites.getByCode(code)
      : await findByToken(ctx.repos.invites, tokenOrCode);
  const league = invite === null ? null : await ctx.repos.leagues.get(invite.leagueId);
  if (invite === null || league === null) throw code !== null ? notFoundCode() : notFoundLink();
  if (attempt !== null) await ctx.repos.invites.refundCodeAttempt(attempt.userId, attempt.at);
  return { invite, league };
}

const findByToken = async (invites: Ctx['repos']['invites'], token: string) =>
  isWellFormedInviteToken(token) ? invites.getByTokenHash(hashInviteToken(token)) : null;

/** Reserves the lookup, or throws: UNAUTHENTICATED without a signed-in person, RATE_LIMITED past the cap. */
async function reserveCodeAttempt(
  ctx: Pick<Ctx, 'repos' | 'principal' | 'clock'>
): Promise<{ userId: string; at: Date }> {
  const { principal } = ctx;
  if (principal.type !== 'user') {
    throw new ApiError('UNAUTHENTICATED', 'Sign in to use a join code.', {
      fix: 'Sign in (or create an account), then enter the code again. Invite links work without signing in first.'
    });
  }
  const at = ctx.clock.now();
  if (!(await ctx.repos.invites.takeCodeAttempt(principal.sub, at, MAX_CODE_ATTEMPTS_PER_HOUR))) {
    throw new ApiError('RATE_LIMITED', 'Too many join code attempts.', {
      fix: 'Check the code with the commissioner and try again in an hour, or use the invite link instead.'
    });
  }
  return { userId: principal.sub, at };
}

const notFoundLink = () =>
  new ApiError('INVITE_NOT_FOUND', 'This invite link is not valid.', {
    fix: 'Check that the whole link was copied. If it still fails, ask the commissioner for a new invite link.'
  });

const notFoundCode = () =>
  new ApiError('INVITE_NOT_FOUND', 'No league matches this join code.', {
    fix: 'Check the code with the commissioner (letters and numbers, no O, I, L, 0 or 1). If it still fails, ask for a new invite.'
  });

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
