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
 *
 * Visibility (#206): what a prompt produces reaches other people (a league room, a DM partner, a
 * trade note, the commissioner's activity log), so some memories may reach only some prompts. Each
 * note, decision, trade, and rivalry has a `MemoryVisibility`: `public`, or a `MemorySeal` naming
 * the teams that already know it and the moves (trades, waiver claims) whose resolution releases
 * it. `memoryForAudience` keeps what a prompt's audience may hear, before the prompt is assembled.
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

/**
 * A private memory (#206): sealed with the same release rules as the activity log (#122). `teams`
 * are the other teams that already know it (the other side of a private offer); `trades` and
 * `waiverClaims` are the moves whose resolution makes it public. A seal naming no moves never lifts
 * (a rejected offer, or a memory from before visibility was recorded).
 */
export const MemorySealSchema = z.object({
  teams: z.array(z.string()).default([]),
  trades: z.array(z.object({ tradeId: z.string(), until: z.enum(['public', 'final']) })).default([]),
  waiverClaims: z.array(z.string()).default([])
});
export type MemorySeal = z.infer<typeof MemorySealSchema>;

export const MemoryVisibilitySchema = z.union([z.literal('public'), MemorySealSchema]);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

/** Known to this agent alone, for good. */
export const OWNER_ONLY: MemorySeal = { teams: [], trades: [], waiverClaims: [] };

export const RivalSchema = z.object({
  teamId: z.string(),
  /** Grows with every loss to them, trade spat, and chat jab; the biggest grudges are kept. */
  grudge: z.number().int().min(0),
  /** The latest reason, in words. */
  reason: Text,
  at: z.string(),
  /** Who may hear the reason (a private offer's rejection is private); see `rivalVisibility`. */
  visibility: MemoryVisibilitySchema.optional()
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
  at: z.string(),
  /** Absent on decisions from before #206: see `decisionVisibility`. */
  visibility: MemoryVisibilitySchema.optional()
});
export type DecisionMemory = z.infer<typeof DecisionMemorySchema>;

export const NoteSchema = z.object({
  text: Text,
  /** Absent on notes from before #206, which are kept to the agent alone. */
  visibility: MemoryVisibilitySchema.optional()
});
export type NoteMemory = z.infer<typeof NoteSchema>;

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
  /** Notes stored before #206 are bare strings: read as notes with no visibility. */
  notes: z.array(z.union([Text.transform((text): NoteMemory => ({ text })), NoteSchema])).default([]),
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
  /** Notes and decisions without a visibility are kept to the agent alone (`OWNER_ONLY`). */
  | { type: 'note'; text: string; visibility?: MemoryVisibility }
  | {
      type: 'decision';
      kind: string;
      action: string;
      summary: string;
      at: string;
      visibility?: MemoryVisibility;
    }
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
  at: string,
  visibility: MemoryVisibility
): Rival[] {
  if (points <= 0) return [...rivals];
  const current = rivals.find((r) => r.teamId === teamId);
  const next: Rival = {
    teamId,
    grudge: (current?.grudge ?? 0) + points,
    reason: clip(reason),
    at,
    visibility
  };
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
      const note: NoteMemory = { text, visibility: event.visibility ?? OWNER_ONLY };
      return { ...memory, notes: [...memory.notes, note].slice(-MEMORY_LIMITS.notes) };
    }
    case 'decision':
      return {
        ...memory,
        decisions: [
          ...memory.decisions,
          {
            kind: event.kind,
            action: event.action,
            summary: clip(event.summary),
            at: event.at,
            visibility: event.visibility ?? OWNER_ONLY
          }
        ].slice(-MEMORY_LIMITS.decisions)
      };
    case 'matchup': {
      const margin = Math.round((event.pointsFor - event.pointsAgainst) * 100) / 100;
      const result = margin > 0 ? 'beat' : margin < 0 ? 'lost to' : 'tied';
      const reason = `Week ${event.week}: ${result} them ${event.pointsFor}-${event.pointsAgainst}.`;
      // Losing builds a grudge; a blowout loss builds a bigger one. Winning is remembered as bragging rights.
      const points = margin < 0 ? (margin <= -30 ? 3 : 2) : 1;
      return markSeen(
        {
          ...memory,
          rivals: bumpRival(memory.rivals, event.opponentTeamId, points, reason, event.at, 'public')
        },
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
            event.at,
            tradeVisibility(entry)
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
    [...memory.notes].reverse().map((n) => `Your note: ${n.text}`),
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

/** Trade outcomes other teams can see (the trade is public from acceptance on). */
const PUBLIC_TRADE_OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'processed', 'vetoed']);

/**
 * Decision kinds whose summaries can hold sealed moves (bids, offers, votes). A decision stored
 * before #206 has no visibility: from these kinds it is kept to the agent alone; from the rest
 * (lineups, draft picks, names) it was never secret.
 */
export const SEALABLE_DECISION_KINDS: ReadonlySet<string> = new Set([
  'waivers',
  'trade_proposal',
  'trade_response',
  'trade_vote',
  'check_in',
  'post_draft'
]);

export function noteVisibility(note: NoteMemory): MemoryVisibility {
  return note.visibility ?? OWNER_ONLY;
}

export function decisionVisibility(decision: DecisionMemory): MemoryVisibility {
  return decision.visibility ?? (SEALABLE_DECISION_KINDS.has(decision.kind) ? OWNER_ONLY : 'public');
}

/**
 * A trade is private to its two teams until it is accepted, and a rejected or expired offer stays
 * private for good. The entry carries its latest outcome; the seal also lifts once the trade itself
 * is public, in case an event went missing.
 */
export function tradeVisibility(
  trade: Pick<TradeMemory, 'teamId' | 'tradeId' | 'outcome'>
): MemoryVisibility {
  if (PUBLIC_TRADE_OUTCOMES.has(trade.outcome)) return 'public';
  return { teams: [trade.teamId], trades: [{ tradeId: trade.tradeId, until: 'public' }], waiverClaims: [] };
}

/** A rivalry's reason, when it was bumped before #206: one about a private offer stays with that team. */
export function rivalVisibility(rival: Rival): MemoryVisibility {
  if (rival.visibility !== undefined) return rival.visibility;
  return /^Trade (proposed|countered|rejected|expired)\b/.test(rival.reason)
    ? { teams: [rival.teamId], trades: [], waiverClaims: [] }
    : 'public';
}

/**
 * Who reads what a prompt produces, besides the agent's own team:
 * - `owner`: nobody else. The output is a sealed move (a waiver bid, a veto vote) and its activity
 *   log entry stays sealed while any private memory it saw is (the runner extends the seal).
 * - `{ teams }`: those teams (a DM with them, an answer to their offer).
 * - `public`: anyone (a league room, notes to any team, an activity summary that is not sealed).
 */
export type MemoryAudience = 'owner' | 'public' | { teams: readonly string[] };

/** True while a seal holds; a seal naming no moves always holds. */
export type SealCheck = (seal: MemorySeal) => boolean;

/** Whether `audience` may hear a memory with this visibility. */
export function mayHear(visibility: MemoryVisibility, audience: MemoryAudience, sealed: SealCheck): boolean {
  if (visibility === 'public' || !sealed(visibility)) return true;
  if (audience === 'public') return false;
  // A sealed move's own prompt sees what only the agent knows, not what it shares with a team.
  if (audience === 'owner') return visibility.teams.length === 0;
  return audience.teams.length > 0 && audience.teams.every((t) => visibility.teams.includes(t));
}

export interface AudienceMemory {
  memory: AgentLeagueMemory;
  /** The still-sealed memories kept: whatever the prompt produces is sealed until they lift. */
  seals: MemorySeal[];
}

/**
 * The memory a prompt with this audience may see (#206): public memories, released ones, and
 * sealed ones every reader already knows. A rivalry whose reason is withheld is left out whole (its
 * grudge would give the offer away). Chat snapshots and relationship notes are not filtered here:
 * they are untrusted chat, scoped by room (`memoryForPrompt` in the runtime).
 */
export function memoryForAudience(
  memory: AgentLeagueMemory,
  audience: MemoryAudience,
  sealed: SealCheck
): AudienceMemory {
  const seals: MemorySeal[] = [];
  const keep = (visibility: MemoryVisibility): boolean => {
    if (!mayHear(visibility, audience, sealed)) return false;
    if (visibility !== 'public' && sealed(visibility)) seals.push(visibility);
    return true;
  };
  return {
    memory: {
      ...memory,
      notes: memory.notes.filter((n) => keep(noteVisibility(n))),
      decisions: memory.decisions.filter((d) => keep(decisionVisibility(d))),
      trades: memory.trades.filter((t) => keep(tradeVisibility(t))),
      rivals: memory.rivals.filter((r) => keep(rivalVisibility(r)))
    },
    seals
  };
}

/** Every seal in a memory, for looking up which moves are still unresolved. */
export function memorySeals(memory: AgentLeagueMemory): MemorySeal[] {
  return [
    ...memory.notes.map(noteVisibility),
    ...memory.decisions.map(decisionVisibility),
    ...memory.trades.map(tradeVisibility),
    ...memory.rivals.map(rivalVisibility)
  ].filter((v): v is MemorySeal => v !== 'public');
}
