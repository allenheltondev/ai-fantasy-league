import type { ApiFetch } from '../api/client';
import type { TeamDetail } from '../api/types';

/**
 * Shapes from the chat operations (get_chat, post_message, list_chat_rooms, mark_room_read,
 * get_realtime_token) in openapi.json.
 */

/** The room people land in, and where messages from before rooms live. */
export const DEFAULT_ROOM_ID = 'trash-talk';

/** The DM room between two teams: the same id from either side (team ids sorted). */
export function dmRoomId(teamA: string, teamB: string): string {
  const [a, b] = [teamA, teamB].sort();
  return `dm-${a}-${b}`;
}

export type RoomKind = 'fixed' | 'matchup' | 'dm';

/** A chat room as list_chat_rooms returns it. */
export interface ChatRoom {
  roomId: string;
  kind: RoomKind;
  title: string;
  /** Read-only: a matchup room whose week is over. */
  archived: boolean;
  week: number | null;
  teamIds: string[];
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface ChatRooms {
  defaultRoomId: string;
  /**
   * Weeks whose matchup rooms are over (archived), newest first, including the final week once the
   * season is complete. Absent from older servers.
   */
  pastWeeks?: number[];
  rooms: ChatRoom[];
}

/** A player an announcement names (system messages). */
export interface ChatPlayer {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

export interface ChatMessage {
  id: string;
  leagueId: string;
  /** The room (#144); absent only on messages from before rooms. */
  roomId?: string;
  kind: 'user' | 'agent' | 'system';
  /** `avatarSeed`: AI managers only (#159); older agent messages carry the team name as `name`. */
  author: { teamId: string | null; teamName: string | null; name: string; avatarSeed?: string };
  text: string;
  mentionedTeamIds: string[];
  /** The AI manager an untagged message continues a conversation with; absent otherwise. */
  addressedTeamIds?: string[];
  event: { detailType: string; eventId: string } | null;
  /** System messages: the players the event names, shown as cards. */
  players?: ChatPlayer[];
  createdAt: string;
}

export interface ChatPage {
  messages: ChatMessage[];
  nextCursor: string | null;
}

export interface RealtimeInfo {
  enabled: boolean;
  token: string | null;
  endpoint: string | null;
  cacheName: string | null;
  /** `team` is the caller's own private topic (null without a seat). */
  topics: { league: string; global: string; team?: string | null } | null;
  expiresAt: string | null;
  pollIntervalSeconds: number;
}

export interface ChatTeam {
  id: string;
  name: string;
  /** The person, or the AI manager (#159), who manages the team. */
  ownerName: string | null;
  /** An AI manager's avatar seed; absent for people. */
  avatarSeed?: string;
  /** An AI manager plays the team (#177); absent on older lists, where `avatarSeed` says so. */
  ai?: boolean;
  /** The personality the AI manager plays, e.g. "The Spreadsheet". */
  personality?: string | null;
}

export interface ChatApi {
  list(leagueId: string, options?: { limit?: number; after?: string; roomId?: string }): Promise<ChatPage>;
  post(leagueId: string, text: string, roomId?: string): Promise<ChatMessage>;
  rooms(leagueId: string, options?: { pastWeek?: number }): Promise<ChatRooms>;
  markRead(leagueId: string, roomId: string): Promise<void>;
  /** Takes a DM off your room list until someone writes in it again. */
  closeDm(leagueId: string, roomId: string): Promise<void>;
  realtime(leagueId: string): Promise<RealtimeInfo>;
  teams(leagueId: string): Promise<ChatTeam[]>;
}

const league = (leagueId: string) => `/leagues/${encodeURIComponent(leagueId)}`;

export function createChatApi(apiFetch: ApiFetch): ChatApi {
  return {
    async list(leagueId, options = {}) {
      const res = await apiFetch<ChatPage>(`${league(leagueId)}/chat/messages`, {
        query: { limit: options.limit, after: options.after, roomId: options.roomId }
      });
      return res.data;
    },
    async post(leagueId, text, roomId) {
      const res = await apiFetch<{ message: ChatMessage }>(`${league(leagueId)}/chat/messages`, {
        method: 'POST',
        body: roomId === undefined ? { text } : { text, roomId }
      });
      return res.data.message;
    },
    async rooms(leagueId, options = {}) {
      const res = await apiFetch<ChatRooms>(`${league(leagueId)}/chat/rooms`, {
        query: { pastWeek: options.pastWeek }
      });
      return res.data;
    },
    async markRead(leagueId, roomId) {
      await apiFetch(`${league(leagueId)}/chat/rooms/${encodeURIComponent(roomId)}/read`, {
        method: 'POST',
        body: {}
      });
    },
    async closeDm(leagueId, roomId) {
      await apiFetch(`${league(leagueId)}/chat/rooms/${encodeURIComponent(roomId)}/close`, {
        method: 'POST',
        body: {}
      });
    },
    async realtime(leagueId) {
      return (await apiFetch<RealtimeInfo>(`${league(leagueId)}/realtime`)).data;
    },
    async teams(leagueId) {
      const res = await apiFetch<{ teams: TeamDetail[] }>(league(leagueId));
      return res.data.teams.map((t) => ({
        id: t.id,
        name: t.name,
        ownerName: t.ownerName ?? t.manager?.name ?? null,
        ai: t.seatType === 'agent' || Boolean(t.manager),
        ...(t.manager ? { avatarSeed: t.manager.avatarSeed, personality: t.manager.personality } : {})
      }));
    }
  };
}

/** Adds messages by id, keeping the list oldest first. */
export function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[]
): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)
  );
}
