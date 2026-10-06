import { z } from 'zod';
import { ApiError, isApiError } from '../../errors.js';
import { isAgentPlayed, leagueManagers } from '../../league/managers.js';
import { TAKEOVER_PHASES } from '../../league/phase.js';
import { claimableSeats, claimSeat, sameTeamName } from '../../league/seats.js';
import {
  leagueSummary,
  LeagueSummarySchema,
  TeamDetailSchema,
  teamDetail,
  TeamNameSchema
} from '../../league/views.js';
import { defineOperation } from '../../registry/operation.js';
import type { LeaguePhase, Team } from '../../repos/types.js';
import { InviteTokenSchema } from './get-invite.js';
import { assertUsable, findInvite } from './invites.js';

const raced = (what: string) =>
  new ApiError('CONFLICT', `Someone else took ${what} at the same moment.`, {
    fix: 'Retry join_league with a new Idempotency-Key.'
  });

const isConflict = (error: unknown) => isApiError(error) && error.code === 'CONFLICT';

export const joinLeague = defineOperation({
  name: 'join_league',
  method: 'POST',
  path: '/invites/{token}/join',
  summary: 'Join a league with an invite token',
  description: [
    'Takes an open seat in the league the invite belongs to: an open human seat if there is one, otherwise a seat an agent would have played. The seat becomes yours; name it with `teamName` (default "<your name>\'s Team").',
    'A takeover invite (create_takeover_invite) instead hands you the one AI team it names, as it stands (roster, record, pending moves), and also works after the draft; the team keeps its name unless you pass `teamName`.',
    'Fails with a fix when: the token is unknown (INVITE_NOT_FOUND), expired (INVITE_EXPIRED), revoked (INVITE_REVOKED), or used up (INVITE_USED_UP); the invite is for a different email (FORBIDDEN); you already have a seat (ALREADY_A_MEMBER); the draft has started, or for a takeover the draft is running or the season is over (PHASE_NOT_ALLOWED); every seat is taken, or the takeover team already has a person (NO_OPEN_SEATS); or your teamName is taken (CONFLICT).',
    '`token` is the invite token or the six-character join code. Preview first with get_invite. Only signed-in people can join.'
  ].join(' '),
  tags: ['invites', 'leagues'],
  mutation: true,
  auth: 'user',
  input: z.object({ token: InviteTokenSchema, teamName: TeamNameSchema.optional() }),
  output: z.object({ league: LeagueSummarySchema, team: TeamDetailSchema }),
  handler: async (ctx, input) => {
    const principal = ctx.principal;
    /* v8 ignore next -- auth: 'user' guarantees a user principal */
    if (principal.type !== 'user') throw new Error('join_league needs a user principal');
    const now = ctx.clock.now();
    const { invite, league } = await findInvite(ctx, input.token);
    assertUsable(invite, now);
    if (invite.email !== null && invite.email !== principal.email?.toLowerCase()) {
      throw new ApiError('FORBIDDEN', 'This invite is for a different email address.', {
        fix: `Sign in with the account for ${maskEmail(invite.email)}, or ask the commissioner for an invite for your email.`
      });
    }
    assertJoinPhase(league.phase, invite.teamId !== null);
    const teams = await ctx.repos.teams.list(league.id);
    const held = teams.find((t) => t.ownerUserId === principal.sub);
    if (held !== undefined) throw alreadyMember(`Yours is "${held.name}" (teamId "${held.id}").`);
    const seat = invite.teamId === null ? claimableSeats(teams)[0] : takeoverSeat(teams, invite.teamId);
    if (seat === undefined) {
      throw new ApiError('NO_OPEN_SEATS', 'Every seat in this league is taken.', {
        fix: 'Ask the commissioner to raise teamCount (update_league_settings) or to free a seat.'
      });
    }
    // Taking over keeps the team's name unless the person picks a new one.
    const name =
      invite.teamId !== null && input.teamName === undefined
        ? seat.name
        : teamNameFor(teams, seat, input.teamName, principal.name);
    const replacedManager =
      invite.teamId === null ? undefined : (await leagueManagers(ctx, league.id, [seat])).get(seat.id)?.name;

    // No multi-item transactions (see the ADR), so: claim the seat, record the membership (which
    // enforces one seat per person), count the invite use, and undo the earlier steps on a race.
    let team: Team;
    try {
      team = await ctx.repos.teams.update(
        claimSeat(seat, { userId: principal.sub, name: principal.name }, name, now)
      );
    } catch (error) {
      throw isConflict(error) ? raced('that seat') : error;
    }
    const undoSeat = () => ctx.repos.teams.update({ ...seat, version: team.version });
    const member = {
      leagueId: league.id,
      userId: principal.sub,
      teamId: team.id,
      joinedAt: now.toISOString()
    };
    if (!(await ctx.repos.members.add(member))) {
      await undoSeat();
      throw alreadyMember('Use get_league_state to see your team.');
    }
    try {
      await ctx.repos.invites.update({ ...invite, uses: invite.uses + 1 });
    } catch (error) {
      await ctx.repos.members.remove(league.id, principal.sub);
      await undoSeat();
      throw isConflict(error) ? raced('this invite') : error;
    }

    await ctx.events.publish('Member Joined', {
      leagueId: league.id,
      userId: principal.sub,
      teamId: team.id,
      inviteId: invite.id,
      name: principal.name,
      ...(replacedManager === undefined ? {} : { replacedManager })
    });
    return { league: leagueSummary(league, principal.sub, team.id), team: teamDetail(team) };
  }
});

/** Anyone joins in setup; a takeover invite also works in season (TAKEOVER_PHASES). */
function assertJoinPhase(phase: LeaguePhase, takeover: boolean): void {
  if (!takeover) {
    if (phase === 'setup') return;
    throw new ApiError(
      'PHASE_NOT_ALLOWED',
      'This league has already started its draft, so no one new can join.',
      {
        fix: 'People can join only while a league is in setup. Ask the commissioner for an invite to take over an AI team instead.',
        details: { phase, allowedPhases: ['setup'] }
      }
    );
  }
  if (TAKEOVER_PHASES.includes(phase)) return;
  throw new ApiError(
    'PHASE_NOT_ALLOWED',
    phase === 'drafting'
      ? 'The draft is running, so no one can take over a team right now.'
      : 'The season is over, so no one can take over a team.',
    {
      fix:
        phase === 'drafting'
          ? 'Try the invite again once the draft is finished.'
          : 'Ask the commissioner about next season.',
      details: { phase, allowedPhases: [...TAKEOVER_PHASES] }
    }
  );
}

/** The AI team a takeover invite names; NO_OPEN_SEATS once a person plays it or it is gone. */
function takeoverSeat(teams: readonly Team[], teamId: string): Team {
  const team = teams.find((t) => t.id === teamId);
  if (team === undefined || !isAgentPlayed(team)) {
    throw new ApiError('NO_OPEN_SEATS', 'This team is no longer played by an AI manager.', {
      fix: 'Someone else took it over already. Ask the commissioner for an invite to another team.'
    });
  }
  return team;
}

function alreadyMember(detail: string): ApiError {
  return new ApiError('ALREADY_A_MEMBER', 'You already have a seat in this league.', {
    fix: `Each person holds one seat per league. ${detail}`
  });
}

/** The chosen name (CONFLICT if another team has it), or a default made unique with the seat number. */
function teamNameFor(
  teams: readonly Team[],
  seat: Team,
  chosen: string | undefined,
  personName: string
): string {
  const taken = (name: string) => teams.some((t) => t.id !== seat.id && sameTeamName(t.name, name));
  if (chosen !== undefined) {
    if (taken(chosen)) {
      throw new ApiError('CONFLICT', `Another team is already named "${chosen}".`, {
        fix: 'Pick a different teamName.'
      });
    }
    return chosen;
  }
  const base = `${personName}'s Team`;
  return taken(base) ? `${base} ${seat.draftSlot}` : base;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
