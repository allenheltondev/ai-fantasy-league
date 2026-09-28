/**
 * Lambda entrypoint for the agent trigger router (EventBridge rule on league events).
 * Bundled by scripts/package-server.sh as `agent-router.mjs`, export `handler`.
 */
import type { Services } from '@fantasy/server';
import type { BusEvent } from '../events.js';
import { leagueRosterIndex, routeEvent, type RouteDecision, type RouterDeps } from '../router.js';
import { defaultTaskKinds } from '../tasks/index.js';
import { createAgentServices, loadAgentEnv } from './env.js';

let deps: RouterDeps | null = null;

export function createRouterDeps(services: Services): RouterDeps {
  return { services, kinds: defaultTaskKinds, rosterIndex: leagueRosterIndex(services) };
}

export async function handler(event: BusEvent): Promise<{ decisions: RouteDecision[] }> {
  deps ??= createRouterDeps(createAgentServices(loadAgentEnv(process.env)));
  return { decisions: await routeEvent(deps, event) };
}
