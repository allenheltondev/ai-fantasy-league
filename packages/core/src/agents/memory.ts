import { z } from 'zod';

/**
 * Per-agent league memory (issue #44): a compact, bounded record of what an agent has lived through
 * in one league, summarized into its prompt within a token budget.
 *
 * - `notes`: facts the agent wrote down itself (`memoryNote` on a decision).
 * - `rivals`: grudges by team, built from matchup results, trades, and chat.
 * - `trades`: the agent's trade history with each team.
 * - `decisions`: its own recent decisions (what it did and why).
 * - `chat`: a snapshot of the latest group-chat exchange it took part in (conversation context
 *   across sessions).
 *
 * Memory is private to one agent: it is keyed by league and agent id and only that agent's tasks
 * read it. Everything here is pure; the storage lives behind `AgentMemoryStore` in the runtime.
 */

export const MEMORY_LIMITS = {
  notes: 20,
  rivals: 8,
  trades: 12,
  decisions: 10,
  chat: 8,
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
  at: z.string()
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

export const AgentLeagueMemorySchema = z.object({
  notes: z.array(Text).default([]),
  rivals: z.array(RivalSchema).default([]),
  trades: z.array(TradeMemorySchema).default([]),
  decisions: z.array(DecisionMemorySchema).default([]),
  chat: z.array(ChatMemorySchema).default([])
});
export type AgentLeagueMemory = z.infer<typeof AgentLeagueMemorySchema>;

export function emptyMemory(): AgentLeagueMemory {
  return { notes: [], rivals: [], trades: [], decisions: [], chat: [] };
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
    }
  | {
      type: 'trade';
      teamId: string;
      tradeId: string;
      outcome: (typeof TRADE_MEMORY_OUTCOMES)[number];
      summary: string;
      at: string;
    }
  | { type: 'chat'; messages: readonly ChatMemory[] };

/** One line, no fence markers (memory is quoted into prompts), at most `MEMORY_LIMITS.text` characters. */
const clip = (text: string) => {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/<<<|>>>|```/g, "''")
    .trim();
  return flat.length > MEMORY_LIMITS.text ? `${flat.slice(0, MEMORY_LIMITS.text - 1)}…` : flat;
};

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

/** Applies one event to a memory and returns the new, bounded memory. Never mutates its input. */
export function rememberEvent(memory: AgentLeagueMemory, event: MemoryEvent): AgentLeagueMemory {
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
      return { ...memory, rivals: bumpRival(memory.rivals, event.opponentTeamId, points, reason, event.at) };
    }
    case 'trade': {
      const entry: TradeMemory = {
        teamId: event.teamId,
        tradeId: event.tradeId,
        outcome: event.outcome,
        summary: clip(event.summary),
        at: event.at
      };
      return {
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
      };
    }
    case 'chat':
      return {
        ...memory,
        chat: event.messages
          .slice(-MEMORY_LIMITS.chat)
          .map((m) => ({ author: clip(m.author), text: clip(m.text), at: m.at }))
      };
  }
}

/** A rough token estimate (about four characters per token), good enough for prompt budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default prompt budget for the memory section, in estimated tokens. */
export const MEMORY_TOKEN_BUDGET = 400;

/**
 * The memory as prompt lines, most useful first (rivalries, trades, the agent's own notes, recent
 * decisions, the last chat exchange), cut off once `tokenBudget` is spent. Newest entries win within
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
    [...memory.trades].reverse().map((t) => `Trade with ${name(t.teamId)} (${t.outcome}): ${t.summary}`),
    [...memory.notes].reverse().map((n) => `Your note: ${n}`),
    [...memory.decisions].reverse().map((d) => `You did ${d.kind} -> ${d.action}: ${d.summary}`),
    memory.chat.length === 0
      ? []
      : [`Last chat you were in: ${memory.chat.map((c) => `${c.author}: ${c.text}`).join(' | ')}`]
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
