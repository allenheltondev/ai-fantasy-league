import {
  decodeCursor,
  encodeCursor,
  messageSortKey,
  roomPrefix,
  UNREAD_CAP,
  type ChatActivity,
  type ChatMessage,
  type ChatPage,
  type ChatPutOptions,
  type ChatRepository,
  type RoomSummary
} from '../chat/model.js';

interface LeagueChat {
  /** By sort key. */
  messages: Map<string, ChatMessage>;
  /** DM room ids by team. */
  dms: Map<string, Set<string>>;
  /** `lastReadAt` by `<reader>#<roomId>`. */
  reads: Map<string, string>;
}

/** In-memory chat, with the same ordering, cursors, and read markers as the DynamoDB repository. */
export class InMemoryChatRepository implements ChatRepository {
  readonly #byLeague = new Map<string, LeagueChat>();

  #league(leagueId: string): LeagueChat {
    let chat = this.#byLeague.get(leagueId);
    if (chat === undefined) {
      chat = { messages: new Map(), dms: new Map(), reads: new Map() };
      this.#byLeague.set(leagueId, chat);
    }
    return chat;
  }

  async put(message: ChatMessage, options: ChatPutOptions = {}): Promise<boolean> {
    const chat = this.#league(message.leagueId);
    const key = messageSortKey(message);
    if (chat.messages.has(key)) return false;
    chat.messages.set(key, structuredClone(message));
    for (const teamId of options.dmTeamIds ?? []) {
      chat.dms.set(teamId, (chat.dms.get(teamId) ?? new Set()).add(message.roomId));
    }
    return true;
  }

  /** A room's sort keys, newest first. */
  #keys(leagueId: string, roomId: string): string[] {
    const prefix = roomPrefix(roomId);
    return [...(this.#byLeague.get(leagueId)?.messages.keys() ?? [])]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .reverse();
  }

  async list(leagueId: string, roomId: string, query: { limit: number; cursor?: string }): Promise<ChatPage> {
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor, roomId);
    const keys = this.#keys(leagueId, roomId).filter((key) => after === null || key < after);
    const page = keys.slice(0, query.limit);
    const messages = page.map((key) =>
      structuredClone(this.#byLeague.get(leagueId)?.messages.get(key) as ChatMessage)
    );
    const last = page.at(-1);
    return {
      messages,
      nextCursor: keys.length > query.limit && last !== undefined ? encodeCursor(last) : null
    };
  }

  async summary(
    leagueId: string,
    roomId: string,
    lastReadAt: string | null,
    visibleFrom: string | null = null
  ): Promise<RoomSummary> {
    const messages = this.#keys(leagueId, roomId)
      .map((key) => this.#byLeague.get(leagueId)?.messages.get(key) as ChatMessage)
      .filter((m) => visibleFrom === null || m.createdAt >= visibleFrom);
    const unread = messages.filter((m) => lastReadAt === null || m.createdAt > lastReadAt);
    return {
      lastMessageAt: messages[0]?.createdAt ?? null,
      unreadCount: Math.min(unread.length, UNREAD_CAP)
    };
  }

  async activity(leagueId: string, since: string): Promise<ChatActivity[]> {
    return [...(this.#byLeague.get(leagueId)?.messages.values() ?? [])]
      .filter((m) => m.createdAt > since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((m) => ({
        messageId: m.id,
        roomId: m.roomId,
        kind: m.kind,
        teamId: m.author.teamId,
        createdAt: m.createdAt,
        replyToAgentDepth: m.replyToAgentDepth ?? 0
      }));
  }

  async dmRooms(leagueId: string, teamId: string): Promise<string[]> {
    return [...(this.#byLeague.get(leagueId)?.dms.get(teamId) ?? [])].sort();
  }

  async readState(leagueId: string, reader: string): Promise<Record<string, string>> {
    const prefix = `${reader}#`;
    return Object.fromEntries(
      [...(this.#byLeague.get(leagueId)?.reads ?? [])]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, at]) => [key.slice(prefix.length), at])
    );
  }

  async markRead(leagueId: string, reader: string, roomId: string, at: string): Promise<void> {
    const reads = this.#league(leagueId).reads;
    const key = `${reader}#${roomId}`;
    const current = reads.get(key);
    if (current === undefined || current < at) reads.set(key, at);
  }

  async deleteLeague(leagueId: string): Promise<void> {
    this.#byLeague.delete(leagueId);
  }
}
