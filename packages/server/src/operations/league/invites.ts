import { ApiError } from '../../errors.js';
import type { Ctx } from '../../context.js';
import { hashInviteToken, isWellFormedInviteToken, parseInviteCode } from '../../league/tokens.js';
import { inviteStatus } from '../../league/views.js';
import type { Invite, League } from '../../repos/types.js';

/** Shared by get_invite and join_league: find an invite by its token or join code and check it can be used. */

/** Join-code lookups a person can miss in one clock hour before they are told to wait. */
export const MAX_CODE_MISSES_PER_HOUR = 10;

/**
 * The invite and its league; INVITE_NOT_FOUND when either is gone (a deleted league takes its
 * invites). `tokenOrCode` is the secret from an invite link or a join code typed by hand. Codes are
 * short enough to guess, so looking one up needs a signed-in person, and each person's misses are
 * counted: after `MAX_CODE_MISSES_PER_HOUR` in an hour, further lookups get RATE_LIMITED.
 */
export async function findInvite(
  ctx: Pick<Ctx, 'repos' | 'principal' | 'clock'>,
  tokenOrCode: string
): Promise<{ invite: Invite; league: League }> {
  const code = parseInviteCode(tokenOrCode);
  const invite =
    code !== null ? await findByCode(ctx, code) : await findByToken(ctx.repos.invites, tokenOrCode);
  const league = invite === null ? null : await ctx.repos.leagues.get(invite.leagueId);
  if (invite === null || league === null) {
    if (code !== null && ctx.principal.type === 'user') {
      await ctx.repos.invites.recordCodeMiss(ctx.principal.sub, ctx.clock.now());
    }
    throw code !== null ? notFoundCode() : notFoundLink();
  }
  return { invite, league };
}

const findByToken = async (invites: Ctx['repos']['invites'], token: string) =>
  isWellFormedInviteToken(token) ? invites.getByTokenHash(hashInviteToken(token)) : null;

async function findByCode(
  ctx: Pick<Ctx, 'repos' | 'principal' | 'clock'>,
  code: string
): Promise<Invite | null> {
  const { principal } = ctx;
  if (principal.type !== 'user') {
    throw new ApiError('UNAUTHENTICATED', 'Sign in to use a join code.', {
      fix: 'Sign in (or create an account), then enter the code again. Invite links work without signing in first.'
    });
  }
  const misses = await ctx.repos.invites.codeMisses(principal.sub, ctx.clock.now());
  if (misses >= MAX_CODE_MISSES_PER_HOUR) {
    throw new ApiError('RATE_LIMITED', 'Too many join codes that did not match.', {
      fix: 'Check the code with the commissioner and try again in an hour, or use the invite link instead.'
    });
  }
  return ctx.repos.invites.getByCode(code);
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
