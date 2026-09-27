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
