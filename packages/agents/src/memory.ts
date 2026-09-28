import { canonicalEvent } from '@fantasy/server';
import {
  MEMORY_TOKEN_BUDGET,
  rememberEvent,
  type AgentLeagueMemory,
  type MemoryEvent,
  type ReasoningEffort
} from '@fantasy/core';
import type { AgentRepository, Services } from '@fantasy/server';
import { z } from 'zod';
import type { BusEvent } from './events.js';

/**
 * Agent memory (issue #44): each agent's private, compact league memory (rivalries, trade history
 * with each team, its own past decisions, and a snapshot of the last chat it joined), summarized
 * into its prompt within a token budget (`prompt.ts`).
 *
 * Storage sits behind `AgentMemoryStore`. The implementation today is the league table
 * (`tableMemoryStore`, one item per agent). `@readysetcloud/agent` has no AgentCore Memory client
 * (in rsc-core the AgentCore runtime host owns that), so a managed-memory backend is a follow-up
 * that only has to implement this interface.
 *
 * Trust: memory written from chat (the per-room conversation snapshots and the relationship notes)
 * is untrusted text. It is shown only to chat tasks, which have no tools; decision tasks never see
 * it (see `memoryForPrompt`). A chat task sees only its own room's snapshot, and relationship notes
 * only for the teams in that conversation; a DM task sees neither (#153).
 */

export interface AgentMemoryStore {
  load(leagueId: string, agentId: string): Promise<AgentLeagueMemory>;
  remember(leagueId: string, agentId: string, events: readonly MemoryEvent[]): Promise<AgentLeagueMemory>;
}

export function tableMemoryStore(repo: AgentRepository): AgentMemoryStore {
  return {
    load: (leagueId, agentId) => repo.getMemory(leagueId, agentId),
    remember: (leagueId, agentId, events) =>
      repo.updateMemory(leagueId, agentId, (memory) => events.reduce(rememberEvent, memory))
  };
}

/** Memory prompt budget by reasoning effort: deeper thinkers remember more. */
export const MEMORY_BUDGETS: Readonly<Record<ReasoningEffort, number>> = {
  low: MEMORY_TOKEN_BUDGET / 2,
  medium: MEMORY_TOKEN_BUDGET,
  high: MEMORY_TOKEN_BUDGET * 2
};

/** Where a chat task talks: the room, whether it is a DM, and the other teams in the conversation. */
export interface ChatMemoryScope {
  roomId: string;
  dm: boolean;
  teamIds: readonly string[];
}

/**
 * The memory a task may see. Tool-using (decision) tasks never get chat snapshots or relationship
 * notes: that is text other people wrote (or the model wrote after reading it), and it must not
 * reach a task that can change a roster. A chat task gets only its room's snapshot and the notes
 * about the teams in the conversation; in a DM, or without a scope, neither.
 */
export function memoryForPrompt(
  memory: AgentLeagueMemory,
  role: 'decision' | 'chat',
  scope?: ChatMemoryScope
): AgentLeagueMemory {
  if (role !== 'chat' || scope === undefined || scope.dm)
    return { ...memory, chatRooms: [], relationships: [] };
  return {
    ...memory,
    chatRooms: memory.chatRooms.filter((r) => r.roomId === scope.roomId),
    relationships: memory.relationships.filter((r) => scope.teamIds.includes(r.teamId))
  };
}

/** League events that write agent memory. The router function receives them with its triggers. */
export const MEMORY_EVENTS = [
  'Week Provisionally Final',
  'Trade Proposed',
  'Trade Countered',
  'Trade Accepted',
  'Trade Rejected',
  'Trade Expired',
  'Trade Processed',
  'Trade Vetoed'
] as const;

const TRADE_OUTCOMES = {
  'Trade Proposed': 'proposed',
  'Trade Countered': 'countered',
  'Trade Accepted': 'accepted',
  'Trade Rejected': 'rejected',
  'Trade Expired': 'expired',
  'Trade Processed': 'processed',
  'Trade Vetoed': 'vetoed'
} as const;

const WeekFinalSchema = z.object({
  leagueId: z.string(),
  week: z.number().int(),
  matchups: z.array(
    z.object({
      homeTeamId: z.string(),
      awayTeamId: z.string(),
      homeScore: z.number().nullable(),
      awayScore: z.number().nullable()
    })
  )
});

const Names = z
  .array(z.object({ name: z.string() }))
  .optional()
  .transform((refs) => refs?.map((r) => r.name));
const TradeSchema = z.object({
  leagueId: z.string(),
  tradeId: z.string(),
  fromTeamId: z.string(),
  toTeamId: z.string(),
  fromPlayers: Names,
  toPlayers: Names
});

/**
 * Writes memory for the agents a league event involves: matchup results for every agent that
 * played, and trade steps for the agents on either side (with the players each side sent once the
 * trade is processed). Returns how many agents were updated. Only structured fields are stored (ids,
 * scores, outcomes, player names); no free text from the event. Each write carries the event id, so
 * a redelivered event changes nothing (core `rememberEvent`).
 */
export async function recordLeagueMemory(
  services: Services,
  event: BusEvent,
  store: AgentMemoryStore = tableMemoryStore(services.repos.agents)
): Promise<number> {
  event = canonicalEvent(event);
  if (event.source !== 'fantasy') return 0;
  const detailType = event['detail-type'];
  const at = event.time ?? services.clock.now().toISOString();
  const writes: { leagueId: string; teamId: string; event: MemoryEvent }[] = [];

  if (detailType === 'Week Provisionally Final') {
    const parsed = WeekFinalSchema.safeParse(event.detail);
    if (!parsed.success) return 0;
    const { leagueId, week } = parsed.data;
    for (const m of parsed.data.matchups) {
      if (m.homeScore === null || m.awayScore === null) continue;
      const sides = [
        {
          teamId: m.homeTeamId,
          opponentTeamId: m.awayTeamId,
          pointsFor: m.homeScore,
          pointsAgainst: m.awayScore
        },
        {
          teamId: m.awayTeamId,
          opponentTeamId: m.homeTeamId,
          pointsFor: m.awayScore,
          pointsAgainst: m.homeScore
        }
      ];
      for (const { teamId, ...rest } of sides) {
        writes.push({ leagueId, teamId, event: { type: 'matchup', week, at, eventId: event.id, ...rest } });
      }
    }
  } else if (detailType in TRADE_OUTCOMES) {
    const parsed = TradeSchema.safeParse(event.detail);
    if (!parsed.success) return 0;
    const { leagueId, tradeId, fromTeamId, toTeamId, fromPlayers, toPlayers } = parsed.data;
    const outcome = TRADE_OUTCOMES[detailType as keyof typeof TRADE_OUTCOMES];
    // What changed hands is worth remembering once it has (who won the trade).
    const moved = (sent: string[] | undefined, received: string[] | undefined) =>
      outcome === 'processed' && sent !== undefined && received !== undefined ? { sent, received } : {};
    writes.push(
      {
        leagueId,
        teamId: fromTeamId,
        event: {
          type: 'trade',
          teamId: toTeamId,
          tradeId,
          outcome,
          summary: `Your offer to ${toTeamId} was ${outcome}.`,
          at,
          eventId: event.id,
          ...moved(fromPlayers, toPlayers)
        }
      },
      {
        leagueId,
        teamId: toTeamId,
        event: {
          type: 'trade',
          teamId: fromTeamId,
          tradeId,
          outcome,
          summary: `An offer from ${fromTeamId} was ${outcome}.`,
          at,
          eventId: event.id,
          ...moved(toPlayers, fromPlayers)
        }
      }
    );
  } else {
    return 0;
  }

  const leagueId = writes[0]?.leagueId;
  if (leagueId === undefined) return 0;
  const seats = await services.repos.agents.listSeats(leagueId);
  let updated = 0;
  for (const write of writes) {
    const seat = seats.find((s) => s.teamId === write.teamId);
    if (seat === undefined) continue;
    await store.remember(leagueId, seat.agentId, [write.event]);
    updated += 1;
  }
  services.log.info('agent memory recorded', { detailType, leagueId, agents: updated });
  return updated;
}
