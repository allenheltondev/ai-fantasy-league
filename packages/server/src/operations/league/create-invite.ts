import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireCommissioner } from '../../league/access.js';
import { assertAction } from '../../league/phase.js';
import { claimableSeats } from '../../league/seats.js';
import { hashInviteToken, newInviteToken } from '../../league/tokens.js';
import { inviteView, InviteViewSchema, LeagueIdSchema } from '../../league/views.js';
import { defineOperation, withWarnings, type Warning } from '../../registry/operation.js';
import type { Invite } from '../../repos/types.js';

export const DEFAULT_INVITE_HOURS = 7 * 24;

export const createInvite = defineOperation({
  name: 'create_invite',
  method: 'POST',
  path: '/leagues/{leagueId}/invites',
  summary: 'Create an invite link for people to join (commissioner only)',
  description: [
    'Creates an invite and returns its secret `token` exactly once; share `joinPath` (or the token) with the people you want in the league. They preview it with get_invite and join with join_league, taking an open seat.',
    'Defaults: one use, expires in 7 days (168 hours), anyone with the link. Set `email` to restrict it to one person, `maxUses` for a group link.',
    'Only the commissioner can create invites, and only while the league is in setup (before the draft). The token cannot be read again later: create a new invite if it is lost, and revoke_invite the old one.'
  ].join(' '),
  tags: ['leagues', 'invites'],
  mutation: true,
  auth: 'user',
  input: z.object({
    leagueId: LeagueIdSchema,
    email: z
      .email()
      .max(254)
      .optional()
      .describe('Only a person signed in with this email can use the invite.'),
    maxUses: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(1)
      .describe('How many people can join with it (default 1).'),
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
    assertAction('create_invite', access.league, access.actor, now);
    const token = newInviteToken();
    const invite: Invite = {
      id: randomUUID(),
      leagueId: access.league.id,
      tokenHash: hashInviteToken(token),
      email: input.email?.toLowerCase() ?? null,
      maxUses: input.maxUses,
      uses: 0,
      expiresAt: new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      createdBy: access.league.commissionerId,
      createdAt: now.toISOString(),
      version: 1
    };
    await ctx.repos.invites.create(invite);
    const open = claimableSeats(access.teams).length;
    const warnings: Warning[] =
      open >= input.maxUses
        ? []
        : [
            {
              code: 'FEWER_OPEN_SEATS',
              message: `Only ${open} seat(s) are open, fewer than this invite's ${input.maxUses} use(s). Raise teamCount with update_league_settings if more people should join.`
            }
          ];
    return withWarnings({ invite: inviteView(invite, now), token, joinPath: `/join/${token}` }, warnings);
  }
});
