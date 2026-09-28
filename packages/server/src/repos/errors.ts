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

export function draftExists(leagueId: string): ApiError {
  return new ApiError('CONFLICT', `League ${leagueId} has already started its draft.`, {
    fix: 'Read the draft with get_draft_board instead of starting it again.'
  });
}

export function staleDraft(leagueId: string): ApiError {
  return new ApiError(
    'CONFLICT',
    `The draft in league ${leagueId} moved on while this request was running.`,
    {
      fix: 'Another pick landed first. Call get_draft_board to see who is on the clock now, then retry if it is still your turn.'
    }
  );
}
