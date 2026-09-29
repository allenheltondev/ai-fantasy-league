import { recordAttachments } from './attachments.js';
import type { BusEvent } from './events.js';
import { MEMORY_EVENTS, recordLeagueMemory, type AgentMemoryStore } from './memory.js';
import { TRIGGER_RULES, routeEvent, type RouteDecision, type RouterDeps } from './router.js';

/**
 * League-event ingestion for agents (#211): the one path both the router Lambda
 * (`lambda/router.ts`) and the in-process event loop (`loop.ts`, used by the dev server, e2e, and
 * the season simulator) run, so a replay exercises the same memory and routing production does.
 *
 * Every event first updates the memory of the agents it involves (`recordLeagueMemory`, which
 * stores what `leagueMemoryWrites` returns), then is routed to agent tasks (`routeEvent`). Memory
 * comes first so a task the event requests reads a memory that already holds it.
 *
 * - **Events:** the union of routing triggers and memory-only events (`INGESTED_EVENTS`). The
 *   router Lambda's EventBridge rule lists the same set (infra test).
 * - **Redelivery:** both halves are idempotent. Each memory write carries the event id (core
 *   `rememberEvent` drops a repeat), and a routed task's id is keyed by event and team, with
 *   `oncePer` rules and cooldowns gating repeats.
 * - **Memory failure:** logged, and routing still runs. A lost memory write costs recall, never a
 *   decision the league is waiting on; the next delivery of the event (or of a later one) fills it.
 * - **Attachments (#216):** `Draft Completed` and `Trade Processed` (both already ingested) also
 *   create or end player attachments (`recordAttachments`), after memory and before routing, keyed
 *   by pick and trade so a redelivery changes nothing. A failure is logged the same way.
 */
export const INGESTED_EVENTS: readonly string[] = [
  ...new Set([...Object.keys(TRIGGER_RULES), ...MEMORY_EVENTS])
];

export interface IngestDeps extends RouterDeps {
  /** Where memory is written; the league table (`tableMemoryStore`) when omitted. */
  memory?: AgentMemoryStore;
}

export interface IngestResult {
  decisions: RouteDecision[];
  /** How many agents' memories the event updated (0 when the write failed). */
  remembered: number;
}

export async function ingestLeagueEvent(deps: IngestDeps, event: BusEvent): Promise<IngestResult> {
  let remembered = 0;
  try {
    remembered = await recordLeagueMemory(deps.services, event, deps.memory);
  } catch (error) {
    deps.services.log.error('agent memory update failed', { eventId: event.id, error });
  }
  try {
    await recordAttachments(deps.services, event);
  } catch (error) {
    deps.services.log.error('agent attachment update failed', { eventId: event.id, error });
  }
  return { decisions: await routeEvent(deps, event), remembered };
}
