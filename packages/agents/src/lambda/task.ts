/**
 * Lambda entrypoint for agent tasks (EventBridge rule on `Agent Action Requested`).
 * Bundled by scripts/package-server.sh as `agent-task.mjs`, export `handler`.
 */
import { registry, type AgentTaskRecord } from '@fantasy/server';
import { AgentActionRequestedSchema, type BusEvent } from '../events.js';
import { runAgentAction, type RunnerDeps } from '../runner.js';
import { defaultTaskKinds } from '../tasks/index.js';
import { createAgentServices, killSwitchFromEnv, loadAgentEnv, modelFromEnv } from './env.js';

let deps: RunnerDeps | null = null;

async function createDeps(): Promise<RunnerDeps> {
  const env = loadAgentEnv(process.env);
  const services = createAgentServices(env);
  return {
    registry,
    services,
    kinds: defaultTaskKinds,
    model: await modelFromEnv(env),
    killSwitch: killSwitchFromEnv(env, services),
    modelTimeoutMs: env.AGENT_MODEL_TIMEOUT_MS
  };
}

export async function handler(event: BusEvent): Promise<AgentTaskRecord> {
  deps ??= await createDeps();
  return runAgentAction(deps, AgentActionRequestedSchema.parse(event.detail));
}
