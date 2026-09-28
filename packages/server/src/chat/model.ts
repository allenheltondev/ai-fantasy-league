import { DEFAULT_ROOM_ID } from '@fantasy/core';
import { z } from 'zod';

/**
 * League chat (issues #69, #70, #144). Messages live in their own partition, `CHAT#<leagueId>`, so
 * a busy chat never slows league-state queries, and each message belongs to one room (`roomId`, see
 * core `chat/rooms.ts`). Keys are in docs/adr/001-table-design.md, "Chat partition".
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

/**
 * Daily chat budgets for AI managers (#72, #144), across every room: at most `agentPerDay`
 * messages from one agent and `leaguePerDay` from all of a league's agents in any 24 hours.
 */
export const AGENT_CHAT_BUDGETS = {
  agentPerDay: 10,
  leaguePerDay: 30,
  windowMs: 24 * 60 * 60 * 1000
} as const;

export interface AgentChatBudget {
  /** Messages this agent may still post in the next 24 hours. */
  agentRemaining: number;
  /** Messages the league's agents together may still post. */
  leagueRemaining: number;
}

/** What is left of the daily agent budgets, from the league's activity over the last day. */
export function agentChatBudget(
  activity: readonly Pick<ChatActivity, 'kind' | 'teamId' | 'createdAt'>[],
  teamId: string,
  now: Date
): AgentChatBudget {
  const since = new Date(now.getTime() - AGENT_CHAT_BUDGETS.windowMs).toISOString();
  const agents = activity.filter((a) => a.kind === 'agent' && a.createdAt > since);
  return {
    agentRemaining: Math.max(
      0,
      AGENT_CHAT_BUDGETS.agentPerDay - agents.filter((a) => a.teamId === teamId).length
    ),
    leagueRemaining: Math.max(0, AGENT_CHAT_BUDGETS.leaguePerDay - agents.length)
  };
}

export const ChatMessageSchema = z.object({
  id: z.string(),
  leagueId: z.string(),
  roomId: z
    .string()
    .describe(
      'The room: `league`, `trash-talk`, `draft`, `trades`, `waivers-news`, a matchup room `m-<season>-W<nn>-<matchupId>`, or a DM `dm-<teamA>-<teamB>`.'
    ),
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
  players: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        team: z.string().nullable(),
        position: z.string()
      })
    )
    .optional()
    .describe('System messages: the players the event names, shown as cards. Absent on other messages.'),
  createdAt: z.string()
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** Who wrote a message, for rate limits. A person holds one seat per league, so the team identifies them. */
export function authorKey(message: { kind: ChatMessageKind; author: { teamId: string | null } }): string {
  return `${message.kind}#${message.author.teamId ?? 'league'}`;
}

export interface ChatPage {
  /** Newest first. */
  messages: ChatMessage[];
  /** Pass as `after` to read older messages; null when there are none. */
  nextCursor: string | null;
}

/** One message as the league-wide activity index keeps it (no text): for rate limits and budgets. */
export interface ChatActivity {
  messageId: string;
  roomId: string;
  kind: ChatMessageKind;
  teamId: string | null;
  createdAt: string;
}

/** A room's newest message time and how many messages arrived after a reader's `lastReadAt`. */
export interface RoomSummary {
  lastMessageAt: string | null;
  /** Capped at `UNREAD_CAP`. */
  unreadCount: number;
}

/** Unread counts stop counting here (the app shows "99+"). */
export const UNREAD_CAP = 100;
/** How long the activity index keeps a message (it only answers questions about the last day). */
export const ACTIVITY_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export interface ChatPutOptions {
  /** A DM's two teams: the message is listed in both teams' DM lists. */
  dmTeamIds?: readonly [string, string];
}

export interface ChatRepository {
  /**
   * Stores a message in its room; returns false (and changes nothing) when its id and time already
   * exist there. A new message is also added to the league's activity index and, in a DM, to both
   * teams' DM lists.
   */
  put(message: ChatMessage, options?: ChatPutOptions): Promise<boolean>;
  /** One room, newest first, `limit` at a time, continuing after `cursor`. */
  list(leagueId: string, roomId: string, query: { limit: number; cursor?: string }): Promise<ChatPage>;
  /**
   * The room's newest message time and the messages after `lastReadAt` (null: never read),
   * counting only messages created at or after `visibleFrom` when given (a DM seat's new occupant).
   */
  summary(
    leagueId: string,
    roomId: string,
    lastReadAt: string | null,
    visibleFrom?: string | null
  ): Promise<RoomSummary>;
  /** Every message in any room of the league after `since`, newest first (at most the last day). */
  activity(leagueId: string, since: string): Promise<ChatActivity[]>;
  /** The DM rooms a team has messages in. */
  dmRooms(leagueId: string, teamId: string): Promise<string[]>;
  /** When a reader (a principal key) last read each room, by room id. */
  readState(leagueId: string, reader: string): Promise<Record<string, string>>;
  /** Moves the reader's `lastReadAt` for the room forward to `at` (never back). */
  markRead(leagueId: string, reader: string, roomId: string, at: string): Promise<void>;
  /** Deletes every message, read marker, and index item of a league's chat (delete_league). */
  deleteLeague(leagueId: string): Promise<void>;
}

/**
 * Sort key prefix of a room's messages. Trash talk keeps the key every message had before rooms
 * existed (`MSG#`), so those messages are its history with no migration; other rooms are
 * `ROOM#<roomId>#MSG#`.
 */
export function roomPrefix(roomId: string): string {
  return roomId === DEFAULT_ROOM_ID ? 'MSG#' : `ROOM#${roomId}#MSG#`;
}

/** Sort key: `<room prefix><createdAt>#<id>`, so a room query is chronological. */
export function messageSortKey(message: Pick<ChatMessage, 'createdAt' | 'id' | 'roomId'>): string {
  return `${roomPrefix(message.roomId)}${message.createdAt}#${message.id}`;
}

/** A stored message: items written before rooms existed have no `roomId` and are trash talk. */
export function storedMessage(item: Record<string, unknown>): ChatMessage {
  return ChatMessageSchema.parse({ roomId: DEFAULT_ROOM_ID, ...item });
}

/** Cursors are the base64url sort key of the last message returned. */
export function encodeCursor(sortKey: string): string {
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

/** The sort key in a cursor, or null when the cursor is not one of ours for this room. */
export function decodeCursor(cursor: string, roomId: string): string | null {
  const sortKey = Buffer.from(cursor, 'base64url').toString('utf8');
  const prefix = roomPrefix(roomId);
  return sortKey.startsWith(prefix) && /^[^#]+#.+$/.test(sortKey.slice(prefix.length)) ? sortKey : null;
}
