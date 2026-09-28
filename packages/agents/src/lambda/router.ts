/**
 * Lambda entrypoint for the agent trigger router (EventBridge rule on league events).
 * Bundled by scripts/package-server.sh as `agent-router.mjs`, export `handler`.
 */
import type { Services } from '@fantasy/server';
import type { BusEvent } from '../events.js';
import { recordLeagueMemory } from '../memory.js';
import { leagueRosterIndex, routeEvent, type RouteDecision, type RouterDeps } from '../router.js';
import { defaultTaskKinds } from '../tasks/index.js';
import { createAgentServices, loadAgentEnv } from './env.js';

let deps: RouterDeps | null = null;

export function createRouterDeps(services: Services): RouterDeps {
  return { services, kinds: defaultTaskKinds, rosterIndex: leagueRosterIndex(services) };
}

/**
 * Every event first updates the memory of the agents it involves (matchup results, trades), then
 * is routed to agent tasks. A memory failure is logged and never blocks the routing.
 */
export async function handler(event: BusEvent): Promise<{ decisions: RouteDecision[]; remembered: number }> {
  deps ??= createRouterDeps(createAgentServices(loadAgentEnv(process.env)));
  let remembered = 0;
  try {
    remembered = await recordLeagueMemory(deps.services, event);
  } catch (error) {
    deps.services.log.error('agent memory update failed', { eventId: event.id, error });
  }
  return { decisions: await routeEvent(deps, event), remembered };
}
