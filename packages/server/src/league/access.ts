import type { Ctx } from '../context.js';
import { ApiError } from '../errors.js';
import type { League, Team } from '../repos/types.js';
import { actorRoles, isOutsider, resolveActor, type Actor } from './phase.js';

/**
 * League membership authorization (#23). Every league-scoped operation calls one of these guards
 * before it reads or changes anything:
 * - `requireMember`: only people with a seat, the commissioner, and the league's own agents may read.
 * - `requireCommissioner`: only the commissioner configures the league.
 * - `requireTeamOwner`: a member changes only their own team; an agent only the team it plays.
 */

export interface LeagueAccess {
  league: League;
  teams: Team[];
  actor: Actor;
}

export async function requireLeague(ctx: Ctx, leagueId: string): Promise<League> {
  const league = await ctx.repos.leagues.get(leagueId);
  if (league === null) {
    throw new ApiError('LEAGUE_NOT_FOUND', `League "${leagueId}" does not exist.`, {
      fix: 'Check the leagueId. list_my_leagues returns the leagues you belong to.'
    });
  }
  return league;
}

/** The league, its teams, and the caller as the league sees them. No authorization. */
export async function loadAccess(ctx: Ctx, leagueId: string): Promise<LeagueAccess> {
  const league = await requireLeague(ctx, leagueId);
  const teams = await ctx.repos.teams.list(leagueId);
  return { league, teams, actor: resolveActor(league, teams, ctx.principal) };
}

export async function requireMember(ctx: Ctx, leagueId: string): Promise<LeagueAccess> {
  const access = await loadAccess(ctx, leagueId);
  if (isOutsider(access.actor)) {
    throw new ApiError('FORBIDDEN', 'You are not a member of this league.', {
      fix:
        access.actor.kind === 'agent'
          ? 'Agents can only act in the league and team they were created for.'
          : 'Ask the commissioner for an invite link and join with join_league. list_my_leagues shows the leagues you are in.'
    });
  }
  return keepCommissionerEmail(ctx, access);
}

/**
 * Stores the commissioner's email from their ID token when it differs from the league's (#134), so
 * leagues created before it was kept, and leagues handed to a new commissioner, get it the next
 * time the commissioner uses them. The league's version stays as it is, so the write never makes
 * the caller's own change (or anyone else's) a conflict. The write is best effort: a failure is
 * logged and the request goes on with the league as read, and a later request tries again.
 */
async function keepCommissionerEmail(ctx: Ctx, access: LeagueAccess): Promise<LeagueAccess> {
  const { principal } = ctx;
  if (principal.type !== 'user' || principal.email === null) return access;
  const { league } = access;
  if (league.commissionerId !== principal.sub || league.commissionerEmail === principal.email) return access;
  try {
    await ctx.repos.leagues.setCommissionerEmail(league.id, principal.sub, principal.email);
  } catch (error) {
    ctx.log.warn('commissioner email not stored', { leagueId: league.id, error });
    return access;
  }
  return { ...access, league: { ...league, commissionerEmail: principal.email } };
}

export async function requireCommissioner(ctx: Ctx, leagueId: string): Promise<LeagueAccess> {
  const access = await requireMember(ctx, leagueId);
  if (!actorRoles(access.actor).includes('commissioner')) {
    throw new ApiError('FORBIDDEN', 'Only the commissioner can configure this league.', {
      fix: `Ask the commissioner (${access.league.commissionerName}) to make this change.`
    });
  }
  return access;
}

export function requireTeam(access: LeagueAccess, teamId: string): Team {
  const team = access.teams.find((t) => t.id === teamId);
  if (team === undefined) {
    throw new ApiError('TEAM_NOT_FOUND', `Team "${teamId}" is not in this league.`, {
      fix: `Use one of these team ids: ${access.teams.map((t) => t.id).join(', ')}.`
    });
  }
  return team;
}

/**
 * The team, if the caller may change it: its human owner, the agent that plays it, or (with
 * `commissionerForUnowned`) the commissioner when no human owns it.
 */
export function requireTeamOwner(
  access: LeagueAccess,
  teamId: string,
  options: { commissionerForUnowned?: boolean } = {}
): Team {
  const team = requireTeam(access, teamId);
  const { actor } = access;
  if (actor.kind === 'agent') {
    if (actor.team?.id === team.id) return team;
    throw new ApiError('FORBIDDEN', 'Agents can only act for their own team.', {
      fix: `Use your own teamId "${actor.team?.id ?? '(none)'}".`
    });
  }
  if (actor.kind === 'user') {
    if (team.ownerUserId === actor.userId) return team;
    if (options.commissionerForUnowned === true && actor.isCommissioner && team.ownerUserId === null) {
      return team;
    }
  }
  const own = actor.kind === 'user' ? actor.team : null;
  throw new ApiError('FORBIDDEN', `You do not manage team "${team.name}".`, {
    fix:
      own === null
        ? 'You can only change a team you own.'
        : `You can only change your own team, "${own.name}" (teamId "${own.id}").`
  });
}
