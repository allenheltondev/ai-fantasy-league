import type { ApiFetch } from '../api/client';

/** Shapes from the chat operations (get_chat, post_message, get_realtime_token) in openapi.json. */

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
  author: { teamId: string | null; teamName: string | null; name: string };
  text: string;
  mentionedTeamIds: string[];
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
  ownerName: string | null;
}

export interface ChatApi {
  list(leagueId: string, options?: { limit?: number; after?: string }): Promise<ChatPage>;
  post(leagueId: string, text: string): Promise<ChatMessage>;
  realtime(leagueId: string): Promise<RealtimeInfo>;
  teams(leagueId: string): Promise<ChatTeam[]>;
}

const league = (leagueId: string) => `/leagues/${encodeURIComponent(leagueId)}`;

export function createChatApi(apiFetch: ApiFetch): ChatApi {
  return {
    async list(leagueId, options = {}) {
      const res = await apiFetch<ChatPage>(`${league(leagueId)}/chat/messages`, {
        query: { limit: options.limit, after: options.after }
      });
      return res.data;
    },
    async post(leagueId, text) {
      const res = await apiFetch<{ message: ChatMessage }>(`${league(leagueId)}/chat/messages`, {
        method: 'POST',
        body: { text }
      });
      return res.data.message;
    },
    async realtime(leagueId) {
      return (await apiFetch<RealtimeInfo>(`${league(leagueId)}/realtime`)).data;
    },
    async teams(leagueId) {
      const res = await apiFetch<{ teams: ChatTeam[] }>(league(leagueId));
      return res.data.teams.map((t) => ({ id: t.id, name: t.name, ownerName: t.ownerName }));
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
