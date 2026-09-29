import { createContext, useContext } from 'react';
import type { RealtimeInfo } from '../chat/api';
import type { ApiFetch, ApiRequest } from './client';
import type { NotificationInbox, NotificationPreferences, NotificationSummary } from '../notifications/types';
import type {
  AgentActivity,
  AgentCatalog,
  AgentSeatConfig,
  AgentSeatView,
  CreatedInvite,
  DataStatus,
  DefaultSettings,
  Invite,
  InvitePreview,
  LeagueDashboardData,
  LeagueDetail,
  LeagueHistoryData,
  LeagueSettings,
  LeagueState,
  ClaimPreview,
  ClaimResult,
  LineupMove,
  MarketPage,
  MarketQuery,
  MatchupData,
  MatchupOutlook,
  NflGamesData,
  ModelLeaderboard,
  MyLeague,
  PlayerRef,
  PlayoffBracketData,
  Roster,
  ScoringLogData,
  ScoringPreset,
  SeatType,
  StandingsData,
  TeamDetail,
  WaiverClaim
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
    /** rename_team with a name, an avatar seed (#178), or both: your team's profile. */
    setTeamProfile: (id: string, teamId: string, profile: { name?: string; avatarSeed?: string }) =>
      call<{ team: TeamDetail }>(`${league(id)}/teams/${teamId}/name`, { method: 'PUT', body: profile }),
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
      }),

    // Season loop (#52, #58)
    getRoster: (id: string, teamId: string) => call<Roster>(`${league(id)}/teams/${teamId}/roster`),
    /** Returns the warnings too: starting a player on bye or ruled out is allowed but flagged. */
    setLineup: async (id: string, teamId: string, week: number, moves: LineupMove[]) => {
      const res = await api<Roster>(`${league(id)}/teams/${teamId}/lineup`, {
        method: 'PUT',
        body: { week, moves }
      });
      return { roster: res.data, warnings: res.warnings as { code: string; message: string }[] };
    },
    /** Your matchup, or `teamId`'s (a matchup opened from the dashboard, #166). */
    getMatchup: (id: string, teamId?: string) =>
      call<MatchupData>(`${league(id)}/matchup`, teamId === undefined ? undefined : { query: { teamId } }),
    /** get_scoring_log (#162): the matchup's scoring log, newest first, a page at a time. */
    getScoringLog: (
      id: string,
      query: { includeBench?: boolean; limit?: number; cursor?: string; teamId?: string } = {}
    ) => call<ScoringLogData>(`${league(id)}/matchup/scoring-log`, { query }),
    // Roster workspace (#205): the player market, adds and claims, drops, and pending claims
    listLeaguePlayers: (id: string, query: MarketQuery) =>
      call<MarketPage>(`${league(id)}/players`, { query: { ...query } }),
    previewClaim: (id: string, query: { playerId: string; dropPlayerId?: string; bid?: number }) =>
      call<ClaimPreview>(`${league(id)}/waivers/preview`, { query }),
    claimPlayer: (id: string, body: { playerId: string; dropPlayerId?: string; bid?: number }) =>
      call<ClaimResult>(`${league(id)}/waivers/claims`, { method: 'POST', body }),
    dropPlayer: (id: string, playerId: string) =>
      call<{ dropped: PlayerRef; clearsAt: string }>(`${league(id)}/drops`, {
        method: 'POST',
        body: { playerId }
      }),
    listClaims: (id: string) =>
      call<{ claims: WaiverClaim[] }>(`${league(id)}/waivers/claims`).then((d) => d.claims),
    updateClaim: (
      id: string,
      claimId: string,
      changes: { bid?: number; dropPlayerId?: string; clearDrop?: boolean }
    ) =>
      call<{ claim: WaiverClaim }>(`${league(id)}/waivers/claims/${encodeURIComponent(claimId)}`, {
        method: 'PATCH',
        body: changes
      }).then((d) => d.claim),
    cancelClaim: (id: string, claimId: string) =>
      call<unknown>(`${league(id)}/waivers/claims/${encodeURIComponent(claimId)}`, { method: 'DELETE' }),
    reorderClaims: (id: string, claimIds: string[]) =>
      call<{ claims: WaiverClaim[] }>(`${league(id)}/waivers/claims/order`, {
        method: 'PUT',
        body: { claimIds }
      }).then((d) => d.claims),
    getMatchupOutlook: (id: string) => call<MatchupOutlook>(`${league(id)}/matchup/outlook`),
    /** get_nfl_games (#132): the week's NFL games, for the games strip and the red-zone highlights. */
    getNflGames: (id: string) => call<NflGamesData>(`${league(id)}/nfl-games`),
    getStandings: (id: string) => call<StandingsData>(`${league(id)}/standings`),
    /** get_model_leaderboard (#76). */
    getModelLeaderboard: (id: string) => call<ModelLeaderboard>(`${league(id)}/model-leaderboard`),
    /** get_agent_activity (#77): commissioner only. */
    getAgentActivity: (id: string, query: { teamId?: string; limit?: number } = {}) =>
      call<AgentActivity>(`${league(id)}/agent-activity`, { query }),
    /** get_data_status (#181): commissioner only. */
    getDataStatus: (id: string) => call<DataStatus>(`${league(id)}/data-status`),
    /** get_realtime_token: a subscribe-only token for live league events, or `enabled: false`. */
    getRealtime: (id: string) => call<RealtimeInfo>(`${league(id)}/realtime`),
    /** list_chat_rooms, for the league nav's unread badge (the chat page has its own client). */
    listChatRooms: (id: string) =>
      call<{ defaultRoomId: string; rooms: { roomId: string; unreadCount: number }[] }>(
        `${league(id)}/chat/rooms`
      ),
    // Playoffs and history (#78, #81)
    getPlayoffBracket: (id: string) => call<PlayoffBracketData>(`${league(id)}/playoffs`),
    getLeagueHistory: (id: string) => call<LeagueHistoryData>(`${league(id)}/history`),
    /** get_league_dashboard (#166): this week's matchups, the standings, and the move board in one read. */
    getLeagueDashboard: (id: string, query: { moves?: number } = {}) =>
      call<LeagueDashboardData>(`${league(id)}/dashboard`, { query }),

    // Notification inbox (#165)
    getNotificationSummary: () => call<NotificationSummary>('/notifications'),
    listNotifications: (id: string, query: { limit?: number; after?: string } = {}) =>
      call<NotificationInbox>(`${league(id)}/notifications`, { query }),
    /** mark_notifications_read: the given ids, or `all`. */
    markNotificationsRead: (id: string, which: { notificationIds: string[] } | { all: true }) =>
      call<{ leagueId: string; unreadCount: number }>('/notifications/read', {
        method: 'POST',
        body: { leagueId: id, ...which }
      }),
    markNotificationsDelivered: (id: string, notificationIds: string[]) =>
      call<{ leagueId: string }>('/notifications/delivered', {
        method: 'POST',
        body: { leagueId: id, notificationIds }
      }),
    /** get/update_notification_preferences (#200): player news in the inbox, on or off. */
    getNotificationPreferences: () => call<NotificationPreferences>('/notifications/preferences'),
    updateNotificationPreferences: (preferences: NotificationPreferences) =>
      call<NotificationPreferences>('/notifications/preferences', { method: 'PUT', body: preferences })
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
