import { z } from 'zod';

/**
 * Per-agent league memory (issue #44): a compact, bounded record of what an agent has lived through
 * in one league, summarized into its prompt within a token budget.
 *
 * - `notes`: facts the agent wrote down itself (`memoryNote` on a decision).
 * - `rivals`: grudges by team, built from matchup results, trades, and chat.
 * - `trades`: the agent's trade history with each team.
 * - `decisions`: its own recent decisions (what it did and why).
 * - `chatRooms`: per room, a snapshot of the latest exchange it took part in there (conversation
 *   context across sessions). A chat task sees only the snapshot of the room it talks in (#153).
 * - `relationships`: a short line per other team about how the two get along ("rivalry with Big
 *   Tuna after the week 3 trade"), written after a league-room exchange (never from a DM) and shown
 *   only to chat tasks for the teams in the conversation.
 * - `seen`: ids of the league events already applied, so a redelivered event (EventBridge delivers
 *   at least once) never bumps a grudge twice.
 *
 * Memory is private to one agent: it is keyed by league and agent id and only that agent's tasks
 * read it. Everything here is pure; the storage lives behind `AgentMemoryStore` in the runtime.
 */

export const MEMORY_LIMITS = {
  notes: 20,
  rivals: 8,
  trades: 12,
  decisions: 10,
  /** Messages kept in one room's chat snapshot. */
  chat: 8,
  /** Rooms with a chat snapshot (the most recently used rooms win). */
  chatRooms: 6,
  /** Relationship notes, one per other team (the most recent win). */
  relationships: 8,
  /** Characters in a relationship note. */
  relationshipText: 140,
  /** League event ids remembered for idempotency (a redelivery comes soon after the first). */
  seen: 64,
  /** Player names kept per side of a remembered trade. */
  tradePlayers: 6,
  /** Characters kept from any one text field. */
  text: 280
} as const;

const Text = z.string().max(MEMORY_LIMITS.text);

export const RivalSchema = z.object({
  teamId: z.string(),
  /** Grows with every loss to them, trade spat, and chat jab; the biggest grudges are kept. */
  grudge: z.number().int().min(0),
  /** The latest reason, in words. */
  reason: Text,
  at: z.string()
});
export type Rival = z.infer<typeof RivalSchema>;

export const TRADE_MEMORY_OUTCOMES = [
  'proposed',
  'countered',
  'accepted',
  'rejected',
  'expired',
  'processed',
  'vetoed'
] as const;

export const TradeMemorySchema = z.object({
  teamId: z.string(),
  tradeId: z.string(),
  outcome: z.enum(TRADE_MEMORY_OUTCOMES),
  summary: Text,
  at: z.string(),
  /** Players this agent gave up and got (names). */
  sent: z.array(Text).max(MEMORY_LIMITS.tradePlayers).optional(),
  received: z.array(Text).max(MEMORY_LIMITS.tradePlayers).optional(),
  /**
   * The trade value for this agent when it agreed to the deal (best-lineup plus player-value change
   * over the valuation weeks): positive means it won the trade by its own math.
   */
  value: z.number().optional()
});
export type TradeMemory = z.infer<typeof TradeMemorySchema>;

export const DecisionMemorySchema = z.object({
  kind: z.string(),
  action: z.string(),
  summary: Text,
  at: z.string()
});
export type DecisionMemory = z.infer<typeof DecisionMemorySchema>;

export const ChatMemorySchema = z.object({ author: z.string(), text: Text, at: z.string() });
export type ChatMemory = z.infer<typeof ChatMemorySchema>;

export const ChatRoomMemorySchema = z.object({
  roomId: z.string(),
  /** When the agent last talked there. */
  at: z.string(),
  messages: z.array(ChatMemorySchema).max(MEMORY_LIMITS.chat)
});
export type ChatRoomMemory = z.infer<typeof ChatRoomMemorySchema>;

export const RelationshipSchema = z.object({
  teamId: z.string(),
  note: z.string().max(MEMORY_LIMITS.relationshipText),
  at: z.string()
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * Stored memory. Items written before rooms (#153) have a single `chat` snapshot with no room: it is
 * dropped on read (unknown keys are stripped), since nobody can say which room it belongs to.
 */
export const AgentLeagueMemorySchema = z.object({
  notes: z.array(Text).default([]),
  rivals: z.array(RivalSchema).default([]),
  trades: z.array(TradeMemorySchema).default([]),
  decisions: z.array(DecisionMemorySchema).default([]),
  chatRooms: z.array(ChatRoomMemorySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  seen: z.array(z.string()).default([])
});
export type AgentLeagueMemory = z.infer<typeof AgentLeagueMemorySchema>;

export function emptyMemory(): AgentLeagueMemory {
  return { notes: [], rivals: [], trades: [], decisions: [], chatRooms: [], relationships: [], seen: [] };
}

export type MemoryEvent =
  | { type: 'note'; text: string }
  | { type: 'decision'; kind: string; action: string; summary: string; at: string }
  | {
      type: 'matchup';
      opponentTeamId: string;
      week: number;
      pointsFor: number;
      pointsAgainst: number;
      at: string;
      /** The league event it came from: applied once per id. */
      eventId?: string;
    }
  | {
      type: 'trade';
      teamId: string;
      tradeId: string;
      outcome: (typeof TRADE_MEMORY_OUTCOMES)[number];
      summary: string;
      at: string;
      eventId?: string;
      sent?: readonly string[];
      received?: readonly string[];
      value?: number;
    }
  | { type: 'chat'; roomId: string; at: string; messages: readonly ChatMemory[] }
  | { type: 'relationship'; teamId: string; note: string; at: string };

/** One line, no fence markers (memory is quoted into prompts), at most `max` characters. */
function clipTo(text: string, max: number): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/<<<|>>>|```/g, "''")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
const clip = (text: string) => clipTo(text, MEMORY_LIMITS.text);

/** Grudge points by trade outcome: a veto or rejection stings, a done deal leaves a little history. */
const TRADE_GRUDGE: Readonly<Record<(typeof TRADE_MEMORY_OUTCOMES)[number], number>> = {
  proposed: 0,
  countered: 0,
  accepted: 0,
  rejected: 1,
  expired: 0,
  processed: 1,
  vetoed: 2
};

function bumpRival(
  rivals: readonly Rival[],
  teamId: string,
  points: number,
  reason: string,
  at: string
): Rival[] {
  if (points <= 0) return [...rivals];
  const current = rivals.find((r) => r.teamId === teamId);
  const next: Rival = { teamId, grudge: (current?.grudge ?? 0) + points, reason: clip(reason), at };
  return [...rivals.filter((r) => r.teamId !== teamId), next]
    .sort((a, b) => b.grudge - a.grudge || b.at.localeCompare(a.at) || a.teamId.localeCompare(b.teamId))
    .slice(0, MEMORY_LIMITS.rivals);
}

/** Records a league event id as applied (bounded, newest last). */
function markSeen(memory: AgentLeagueMemory, eventId: string | undefined): AgentLeagueMemory {
  if (eventId === undefined) return memory;
  return { ...memory, seen: [...memory.seen, eventId].slice(-MEMORY_LIMITS.seen) };
}

const players = (names: readonly string[] | undefined) =>
  names === undefined ? undefined : names.slice(0, MEMORY_LIMITS.tradePlayers).map(clip);

/**
 * Applies one event to a memory and returns the new, bounded memory. Never mutates its input. An
 * event carrying an `eventId` already applied is ignored, so redelivered league events are
 * idempotent.
 */
export function rememberEvent(memory: AgentLeagueMemory, event: MemoryEvent): AgentLeagueMemory {
  if (
    (event.type === 'matchup' || event.type === 'trade') &&
    event.eventId !== undefined &&
    memory.seen.includes(event.eventId)
  )
    return memory;
  switch (event.type) {
    case 'note': {
      const text = clip(event.text);
      if (text.length === 0) return memory;
      return { ...memory, notes: [...memory.notes, text].slice(-MEMORY_LIMITS.notes) };
    }
    case 'decision':
      return {
        ...memory,
        decisions: [
          ...memory.decisions,
          { kind: event.kind, action: event.action, summary: clip(event.summary), at: event.at }
        ].slice(-MEMORY_LIMITS.decisions)
      };
    case 'matchup': {
      const margin = Math.round((event.pointsFor - event.pointsAgainst) * 100) / 100;
      const result = margin > 0 ? 'beat' : margin < 0 ? 'lost to' : 'tied';
      const reason = `Week ${event.week}: ${result} them ${event.pointsFor}-${event.pointsAgainst}.`;
      // Losing builds a grudge; a blowout loss builds a bigger one. Winning is remembered as bragging rights.
      const points = margin < 0 ? (margin <= -30 ? 3 : 2) : 1;
      return markSeen(
        { ...memory, rivals: bumpRival(memory.rivals, event.opponentTeamId, points, reason, event.at) },
        event.eventId
      );
    }
    case 'trade': {
      // Later steps of a trade keep what earlier ones knew (the players, the value it agreed to).
      const previous = memory.trades.find((t) => t.tradeId === event.tradeId);
      const sent = players(event.sent) ?? previous?.sent;
      const received = players(event.received) ?? previous?.received;
      const value = event.value ?? previous?.value;
      const entry: TradeMemory = {
        teamId: event.teamId,
        tradeId: event.tradeId,
        outcome: event.outcome,
        summary: clip(event.summary),
        at: event.at,
        ...(sent === undefined ? {} : { sent }),
        ...(received === undefined ? {} : { received }),
        ...(value === undefined ? {} : { value: Math.round(value * 10) / 10 })
      };
      return markSeen(
        {
          ...memory,
          trades: [...memory.trades.filter((t) => t.tradeId !== event.tradeId), entry].slice(
            -MEMORY_LIMITS.trades
          ),
          rivals: bumpRival(
            memory.rivals,
            event.teamId,
            TRADE_GRUDGE[event.outcome],
            `Trade ${event.outcome}: ${event.summary}`,
            event.at
          )
        },
        event.eventId
      );
    }
    case 'chat': {
      const room: ChatRoomMemory = {
        roomId: event.roomId,
        at: event.at,
        messages: event.messages
          .slice(-MEMORY_LIMITS.chat)
          .map((m) => ({ author: clip(m.author), text: clip(m.text), at: m.at }))
      };
      return {
        ...memory,
        chatRooms: [...memory.chatRooms.filter((r) => r.roomId !== event.roomId), room].slice(
          -MEMORY_LIMITS.chatRooms
        )
      };
    }
    case 'relationship': {
      const note = clipTo(event.note, MEMORY_LIMITS.relationshipText);
      if (note.length === 0) return memory;
      return {
        ...memory,
        relationships: [
          ...memory.relationships.filter((r) => r.teamId !== event.teamId),
          { teamId: event.teamId, note, at: event.at }
        ].slice(-MEMORY_LIMITS.relationships)
      };
    }
  }
}

/** What changed hands and who won it, for a remembered trade. */
function tradeDetail(t: TradeMemory): string {
  const parts: string[] = [];
  if (t.sent !== undefined || t.received !== undefined)
    parts.push(`you sent ${t.sent?.join(', ') || 'nothing'} for ${t.received?.join(', ') || 'nothing'}`);
  if (t.value !== undefined)
    parts.push(
      `value for you ${t.value > 0 ? '+' : ''}${t.value} (${t.value > 0 ? 'you won it' : t.value < 0 ? 'they won it' : 'even'})`
    );
  return parts.length === 0 ? '' : ` [${parts.join('; ')}]`;
}

/** A rough token estimate (about four characters per token), good enough for prompt budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default prompt budget for the memory section, in estimated tokens. */
export const MEMORY_TOKEN_BUDGET = 400;

/**
 * The memory as prompt lines, most useful first (rivalries, trades, the agent's own notes, recent
 * decisions, relationship notes, the last chat exchange), cut off once `tokenBudget` is spent. Newest entries win within
 * each group. `teamName` turns team ids into names the model can use in chat.
 */
export function summarizeMemory(
  memory: AgentLeagueMemory,
  options: { tokenBudget?: number; teamName?: (teamId: string) => string } = {}
): string[] {
  const budget = options.tokenBudget ?? MEMORY_TOKEN_BUDGET;
  const name = options.teamName ?? ((id: string) => id);
  const groups: string[][] = [
    memory.rivals.map((r) => `Rivalry with ${name(r.teamId)} (grudge ${r.grudge}): ${r.reason}`),
    [...memory.trades]
      .reverse()
      .map((t) => `Trade with ${name(t.teamId)} (${t.outcome}): ${t.summary}${tradeDetail(t)}`),
    [...memory.notes].reverse().map((n) => `Your note: ${n}`),
    [...memory.decisions].reverse().map((d) => `You did ${d.kind} -> ${d.action}: ${d.summary}`),
    [...memory.relationships].reverse().map((r) => `Between you and ${name(r.teamId)}: ${r.note}`),
    [...memory.chatRooms]
      .reverse()
      .filter((r) => r.messages.length > 0)
      .map(
        (r) => `Last chat you were in here: ${r.messages.map((c) => `${c.author}: ${c.text}`).join(' | ')}`
      )
  ];
  const lines: string[] = [];
  let used = 0;
  for (const group of groups) {
    for (const line of group) {
      const cost = estimateTokens(line) + 1;
      if (used + cost > budget) return lines;
      lines.push(line);
      used += cost;
    }
  }
  return lines;
}
