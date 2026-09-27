import { ApiError } from '../errors.js';

export function leagueExists(leagueId: string): ApiError {
  return new ApiError('CONFLICT', `League ${leagueId} already exists.`, {
    fix: 'Create the league with a new id.'
  });
}

export function staleLeague(leagueId: string): ApiError {
  return new ApiError('CONFLICT', `League ${leagueId} changed while this request was running.`, {
    fix: 'Read the league again and retry the change against the latest state.'
  });
}

export function teamExists(teamId: string): ApiError {
  return new ApiError('CONFLICT', `Team ${teamId} already exists.`, {
    fix: 'Read the league again; the team was already created.'
  });
}

export function staleTeam(teamId: string): ApiError {
  return new ApiError('CONFLICT', `Team ${teamId} changed while this request was running.`, {
    fix: 'Read the league again (get_league_state) and retry against the latest state.'
  });
}

export function staleInvite(inviteId: string): ApiError {
  return new ApiError('CONFLICT', `Invite ${inviteId} changed while this request was running.`, {
    fix: 'Retry the request.'
  });
}
