import { z } from 'zod';

/**
 * League group chat (issues #69, #70). Messages live in their own partition, `CHAT#<leagueId>`, so
 * a busy chat never slows league-state queries (docs/adr/001-table-design.md, "Chat partition").
 */

export const CHAT_MESSAGE_KINDS = ['user', 'agent', 'system'] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

/** Limits on `post_message`. */
export const CHAT_LIMITS = {
  /** Characters per message, after trimming. */
  maxLength: 1000,
  /** At most this many messages per author... */
  burstMessages: 5,
  /** ...in this window. */
  burstWindowMs: 60_000
} as const;

export const ChatMessageSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  kind: z
    .enum(CHAT_MESSAGE_KINDS)
    .describe('`user`: a person. `agent`: an AI manager. `system`: the league announcing an event.'),
  author: z.object({
    teamId: z.string().nullable().describe('The author team; null for system messages.'),
    teamName: z.string().nullable(),
    name: z.string().describe('Display name: the person, the agent team, or "League".')
  }),
  text: z.string(),
  mentionedTeamIds: z.array(z.string()).describe('Teams @mentioned in the text.'),
  /** For system messages: the league event it announces. */
  event: z.object({ detailType: z.string(), eventId: z.string() }).nullable(),
  createdAt: z.string()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Who wrote a message, for rate limits. A person holds one seat per league, so the team identifies them. */
export function authorKey(message: Pick<ChatMessage, 'kind' | 'author'>): string {
  return `${message.kind}#${message.author.teamId ?? 'league'}`;
}

export interface ChatPage {
  /** Newest first. */
  messages: ChatMessage[];
  /** Pass as `after` to read older messages; null when there are none. */
  nextCursor: string | null;
}

export interface ChatRepository {
  /** Stores a message; returns false (and changes nothing) when its id and time already exist. */
  put(message: ChatMessage): Promise<boolean>;
  /** Newest first, `limit` at a time, continuing after `cursor`. */
  list(leagueId: string, query: { limit: number; cursor?: string }): Promise<ChatPage>;
}

/** Sort key: `MSG#<createdAt>#<id>`, so a partition query is chronological. */
export function messageSortKey(message: Pick<ChatMessage, 'createdAt' | 'id'>): string {
  return `MSG#${message.createdAt}#${message.id}`;
}

/** Cursors are the base64url sort key of the last message returned. */
export function encodeCursor(sortKey: string): string {
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

/** The sort key in a cursor, or null when the cursor is not one of ours. */
export function decodeCursor(cursor: string): string | null {
  const sortKey = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^MSG#[^#]+#.+$/.test(sortKey) ? sortKey : null;
}
