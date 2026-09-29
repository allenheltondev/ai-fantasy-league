/**
 * Lambda entrypoint for agent tasks (EventBridge rule on `Agent Action Requested`), the draft
 * report card grader (`Draft Completed`), which needs the same model access, and the recovery
 * sweep (#207; an EventBridge Scheduler schedule sends `{ "sweep": "agent-recovery" }`).
 * Bundled by scripts/package-server.sh as `agent-task.mjs`, export `handler`.
 */
import { EVENT_DETAIL_SCHEMAS, registry, type AgentTaskRecord, type DraftReportCard } from '@fantasy/server';
import { gradeDraft } from '../draft-report.js';
import { recoverAgentTasks, type RecoveryReport } from '../recovery.js';
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

/** What the recovery schedule sends. */
export interface RecoverySweepEvent {
  sweep: 'agent-recovery';
}

export async function handler(
  event: BusEvent | RecoverySweepEvent
): Promise<AgentTaskRecord | DraftReportCard | RecoveryReport | null> {
  deps ??= await createDeps();
  if ('sweep' in event) return recoverAgentTasks(deps.services);
  if (event['detail-type'] === 'Draft Completed') {
    return gradeDraft(deps, EVENT_DETAIL_SCHEMAS['Draft Completed'].parse(event.detail).leagueId);
  }
  return runAgentAction(deps, AgentActionRequestedSchema.parse(event.detail));
}
