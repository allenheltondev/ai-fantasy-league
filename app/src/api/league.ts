import { createContext, useContext } from 'react';
import type { ApiFetch, ApiRequest } from './client';
import type {
  AgentCatalog,
  AgentSeatConfig,
  AgentSeatView,
  CreatedInvite,
  DefaultSettings,
  Invite,
  InvitePreview,
  LeagueDetail,
  LeagueSettings,
  LeagueState,
  MyLeague,
  ScoringPreset,
  SeatType,
  TeamDetail
} from './types';

/** Typed calls for the league setup operations, each returning the unwrapped `data`. */
export function createLeagueApi(api: ApiFetch) {
  const call = async <T>(path: string, request?: ApiRequest): Promise<T> =>
    (await api<T>(path, request)).data;
  const league = (id: string) => `/leagues/${encodeURIComponent(id)}`;

  return {
    listMyLeagues: () => call<{ leagues: MyLeague[] }>('/leagues').then((d) => d.leagues),
    createLeague: (body: { name: string; teamCount: number; preset: ScoringPreset }) =>
      call<LeagueDetail>('/leagues', { method: 'POST', body }),
    getLeague: (id: string) => call<LeagueDetail>(league(id)),
    getLeagueState: (id: string) => call<LeagueState>(`${league(id)}/state`),
    updateSettings: (id: string, changes: Partial<LeagueSettings>, expectedVersion: number) =>
      call<{ version: number; changedPaths: string[] }>(`${league(id)}/settings`, {
        method: 'PATCH',
        body: { changes, expectedVersion }
      }),
    getDefaultSettings: (query: { teamCount: number; preset: ScoringPreset; startWeek: number }) =>
      call<DefaultSettings>('/settings/defaults', { query }),

    createInvite: (id: string) => call<CreatedInvite>(`${league(id)}/invites`, { method: 'POST', body: {} }),
    listInvites: (id: string) => call<{ invites: Invite[] }>(`${league(id)}/invites`).then((d) => d.invites),
    revokeInvite: (id: string, inviteId: string) =>
      call<{ invite: Invite }>(`${league(id)}/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' }),
    getInvite: (token: string) => call<InvitePreview>(`/invites/${encodeURIComponent(token)}`),
    joinLeague: (token: string, teamName?: string) =>
      call<{ league: MyLeague; team: TeamDetail }>(`/invites/${encodeURIComponent(token)}/join`, {
        method: 'POST',
        body: teamName ? { teamName } : {}
      }),

    setSeatType: (id: string, teamId: string, seatType: SeatType) =>
      call<{ team: TeamDetail }>(`${league(id)}/teams/${teamId}/seat-type`, {
        method: 'PUT',
        body: { seatType }
      }),
    renameTeam: (id: string, teamId: string, name: string) =>
      call<{ team: TeamDetail }>(`${league(id)}/teams/${teamId}/name`, { method: 'PUT', body: { name } }),
    removeMember: (id: string, userId: string) =>
      call<unknown>(`${league(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    transferCommissioner: (id: string, userId: string) =>
      call<unknown>(`${league(id)}/commissioner`, { method: 'POST', body: { userId } }),

    getAgentCatalog: (query: { suggest?: number } = {}) => call<AgentCatalog>('/agents/catalog', { query }),
    getAgentSeat: (id: string, teamId: string) => call<AgentSeatView>(`${league(id)}/agents/${teamId}`),
    configureAgentSeat: (id: string, teamId: string, config: AgentSeatConfig) =>
      call<unknown>(`${league(id)}/agents/${teamId}`, { method: 'PUT', body: config }),
    randomizeAgentSeats: (id: string, teamIds: string[]) =>
      call<{ seats: { teamId: string; config: AgentSeatConfig }[] }>(`${league(id)}/agents/randomize`, {
        method: 'POST',
        body: { teamIds }
      })
  };
}

export type LeagueApi = ReturnType<typeof createLeagueApi>;

/** The API the pages call; tests provide a fake. */
export const LeagueApiContext = createContext<LeagueApi | null>(null);

export function useLeagueApi(): LeagueApi {
  const api = useContext(LeagueApiContext);
  if (api === null) throw new Error('useLeagueApi needs a LeagueApiContext provider');
  return api;
}
