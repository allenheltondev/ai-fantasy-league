import {
  decodeCursor,
  encodeCursor,
  messageSortKey,
  type ChatMessage,
  type ChatPage,
  type ChatRepository
} from '../chat/model.js';

/** In-memory chat, with the same ordering and cursors as the DynamoDB repository. */
export class InMemoryChatRepository implements ChatRepository {
  readonly #byLeague = new Map<string, Map<string, ChatMessage>>();

  async put(message: ChatMessage): Promise<boolean> {
    const messages = this.#byLeague.get(message.leagueId) ?? new Map<string, ChatMessage>();
    this.#byLeague.set(message.leagueId, messages);
    const key = messageSortKey(message);
    if (messages.has(key)) return false;
    messages.set(key, structuredClone(message));
    return true;
  }

  async list(leagueId: string, query: { limit: number; cursor?: string }): Promise<ChatPage> {
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const keys = [...(this.#byLeague.get(leagueId)?.keys() ?? [])]
      .sort()
      .reverse()
      .filter((key) => after === null || key < after);
    const page = keys.slice(0, query.limit);
    const messages = page.map((key) =>
      structuredClone(this.#byLeague.get(leagueId)?.get(key) as ChatMessage)
    );
    const last = page.at(-1);
    return {
      messages,
      nextCursor: keys.length > query.limit && last !== undefined ? encodeCursor(last) : null
    };
  }
}
