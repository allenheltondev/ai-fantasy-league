/**
 * Lambda entrypoint for the agent trigger router (EventBridge rule on league events).
 * Bundled by scripts/package-server.sh as `agent-router.mjs`, export `handler`.
 */
import type { Services } from '@fantasy/server';
import type { BusEvent } from '../events.js';
import { ingestLeagueEvent, type IngestResult } from '../ingest.js';
import { leagueRosterIndex, type RouterDeps } from '../router.js';
import { defaultTaskKinds } from '../tasks/index.js';
import { createAgentServices, loadAgentEnv, responseDelaysOn } from './env.js';

let deps: RouterDeps | null = null;

/** The router's dependencies; in the Lambda, human-like response delays are on (#189). */
export function createRouterDeps(services: Services, responseDelays = true): RouterDeps {
  return { services, kinds: defaultTaskKinds, rosterIndex: leagueRosterIndex(services), responseDelays };
}

/**
 * Every event updates the memory of the agents it involves, then is routed to agent tasks, through
 * the ingestion path the in-process loop shares (`ingestLeagueEvent`). A memory failure is logged
 * and never blocks the routing.
 */
export async function handler(event: BusEvent): Promise<IngestResult> {
  if (deps === null) {
    const env = loadAgentEnv(process.env);
    deps = createRouterDeps(createAgentServices(env), responseDelaysOn(env));
  }
  return ingestLeagueEvent(deps, event);
}
