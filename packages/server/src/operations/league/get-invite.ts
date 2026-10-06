import { z } from 'zod';
import { isAgentPlayed } from '../../league/managers.js';
import { TAKEOVER_PHASES } from '../../league/phase.js';
import { claimableSeats } from '../../league/seats.js';
import { inviteStatus, INVITE_STATUSES, PhaseSchema } from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import { findInvite } from './invites.js';

export const InviteTokenSchema = z
  .string()
  .min(1)
  .max(128)
  .describe(
    'The invite token from the invite link, or the six-character join code (any case, dashes optional).'
  );

export const getInvite = defineOperation({
  name: 'get_invite',
  method: 'GET',
  path: '/invites/{token}',
  summary: 'Preview an invite link before joining',
  description: [
    'Shows what an invite link leads to, without joining: the league name, season, commissioner, phase, how many seats are open, whether the invite can still be used (`status`), and for a takeover invite the AI team it hands over (`takeover`).',
    'Anyone with the token can call it, signed in or not; a join code needs a signed-in person (UNAUTHENTICATED otherwise) and ten lookups in an hour that match nothing return RATE_LIMITED. It shows nothing else about the league. To join, call join_league with the same token or code. An unknown token or code returns INVITE_NOT_FOUND.'
  ].join(' '),
  tags: ['invites'],
  mutation: false,
  auth: 'public',
  input: z.object({ token: InviteTokenSchema }),
  output: z.object({
    leagueName: z.string(),
    season: z.number().int(),
    commissionerName: z.string(),
    phase: PhaseSchema,
    teamCount: z.number().int(),
    openSeats: z.number().int().describe('Seats a person joining now could take.'),
    status: z.enum(INVITE_STATUSES).describe('Only `active` invites can be used to join.'),
    restrictedToEmail: z.boolean().describe('True when only one specific email may use it.'),
    expiresAt: z.string(),
    takeover: z
      .object({
        teamId: z.string(),
        teamName: z.string(),
        available: z.boolean().describe('False once a person already plays the team.')
      })
      .nullable()
      .describe('A takeover invite: the AI team you would take over. Null for an invite to any open seat.'),
    joinable: z.boolean().describe('True when join_league would accept this invite right now.')
  }),
  handler: async (ctx, input) => {
    const { invite, league } = await findInvite(ctx, input.token);
    const teams = await ctx.repos.teams.list(league.id);
    const now = ctx.clock.now();
    const status = inviteStatus(invite, now);
    const openSeats = claimableSeats(teams).length;
    const target = invite.teamId === null ? undefined : teams.find((t) => t.id === invite.teamId);
    const takeover =
      target === undefined
        ? null
        : { teamId: target.id, teamName: target.name, available: isAgentPlayed(target) };
    const joinable =
      status === 'active' &&
      (invite.teamId === null
        ? league.phase === 'setup' && openSeats > 0
        : TAKEOVER_PHASES.includes(league.phase) && takeover?.available === true);
    return {
      leagueName: league.name,
      season: league.season,
      commissionerName: league.commissionerName,
      phase: league.phase,
      teamCount: league.settings.teamCount,
      openSeats,
      status,
      restrictedToEmail: invite.email !== null,
      expiresAt: invite.expiresAt,
      takeover,
      joinable
    };
  }
});
