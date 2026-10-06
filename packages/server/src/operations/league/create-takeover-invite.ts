import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { requireCommissioner, requireTeam } from '../../league/access.js';
import { isAgentPlayed } from '../../league/managers.js';
import { assertAction } from '../../league/phase.js';
import { hashInviteToken, newInviteToken } from '../../league/tokens.js';
import {
  inviteStatus,
  inviteView,
  InviteViewSchema,
  LeagueIdSchema,
  TeamIdSchema
} from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { createWithFreeCode, DEFAULT_INVITE_HOURS } from './create-invite.js';

export const createTakeoverInvite = defineOperation({
  name: 'create_takeover_invite',
  method: 'POST',
  path: '/leagues/{leagueId}/teams/{teamId}/takeover-invites',
  summary: 'Invite a person to take over an AI team (commissioner only)',
  description: [
    'Creates a one-use invite for one AI-played team. The person who joins with it (join_league, by link or by the six-character join code under Join a league) takes over that team as it stands: its roster, lineup, record, waiver priority, FAAB, and pending trades and waiver claims. Its AI manager stops playing it.',
    'Works before the draft and during the regular season and playoffs, but not while the draft is running. Returns the secret `token` exactly once; `invite.code` is shown again by list_invites. Creating a new takeover invite for a team revokes its earlier active ones, so only one person can claim it.',
    'Fails with CONFLICT when a person already plays the team. Only the commissioner can create it.'
  ].join(' '),
  tags: ['leagues', 'invites'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    teamId: TeamIdSchema,
    email: z
      .email()
      .max(254)
      .optional()
      .describe('Only a person signed in with this email can use the invite.'),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(30 * 24)
      .default(DEFAULT_INVITE_HOURS)
      .describe('Hours until it expires (default 168 = 7 days, at most 30 days).')
  }),
  output: z.object({
    invite: InviteViewSchema,
    token: z.string().describe('The secret invite token. Shown only now; only its hash is stored.'),
    joinPath: z.string().describe('App path that opens the invite, e.g. /join/<token>.')
  }),
  handler: async (ctx, input) => {
    const access = await requireCommissioner(ctx, input.leagueId);
    const now = ctx.clock.now();
    assertAction('create_takeover_invite', access.league, access.actor, now);
    const team = requireTeam(access, input.teamId);
    if (!isAgentPlayed(team)) {
      throw new ApiError('CONFLICT', `"${team.name}" is not played by an AI manager.`, {
        fix:
          team.ownerUserId === null
            ? 'This seat is already waiting for a person: use create_invite.'
            : 'Only AI teams can be taken over. Pick a team whose seat type is agent.'
      });
    }
    for (const earlier of await ctx.repos.invites.list(access.league.id)) {
      if (earlier.teamId === team.id && inviteStatus(earlier, now) === 'active') {
        await ctx.repos.invites.update({ ...earlier, revokedAt: now.toISOString() });
      }
    }
    const token = newInviteToken();
    const invite = await createWithFreeCode(ctx, {
      id: randomUUID(),
      leagueId: access.league.id,
      tokenHash: hashInviteToken(token),
      email: input.email?.toLowerCase() ?? null,
      teamId: team.id,
      maxUses: 1,
      uses: 0,
      expiresAt: new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      createdBy: access.league.commissionerId,
      createdAt: now.toISOString(),
      version: 1
    });
    return { invite: inviteView(invite, now), token, joinPath: `/join/${token}` };
  }
});
