/**
 * Lambda entrypoint for agent tasks (EventBridge rule on `Agent Action Requested`) and the draft
 * report card grader (`Draft Completed`), which needs the same model access.
 * Bundled by scripts/package-server.sh as `agent-task.mjs`, export `handler`.
 */
import { EVENT_DETAIL_SCHEMAS, registry, type AgentTaskRecord, type DraftReportCard } from '@fantasy/server';
import { gradeDraft } from '../draft-report.js';
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

export async function handler(event: BusEvent): Promise<AgentTaskRecord | DraftReportCard | null> {
  deps ??= await createDeps();
  if (event['detail-type'] === 'Draft Completed') {
    return gradeDraft(deps, EVENT_DETAIL_SCHEMAS['Draft Completed'].parse(event.detail).leagueId);
  }
  return runAgentAction(deps, AgentActionRequestedSchema.parse(event.detail));
}
