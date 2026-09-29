import { systemClock } from '@fantasy/core';
import {
  EventBridgePublisher,
  createDocumentClient,
  createDynamoReferenceStore,
  createDynamoRepos,
  createLogger,
  createServices,
  type Services
} from '@fantasy/server';
import { z } from 'zod';
import { ScriptedModelClient } from '../fake-model.js';
import { OFF_SWITCH, ParameterKillSwitch, ssmParameterReader, type KillSwitch } from '../kill-switch.js';
import type { ModelClient } from '../model.js';

const EnvSchema = z.object({
  TABLE_NAME: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1).default('default'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** SSM parameter name of the global kill switch; unset means no kill switch. */
  AGENT_KILL_SWITCH_PARAM: z.string().optional(),
  /** `1` uses the scripted fake model instead of Bedrock (tests, local dev). */
  FANTASY_FAKE_MODEL: z.string().optional(),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(90_000),
  /** Human-like response delays before agent tasks (#189): on unless `off`, `0`, or `false`. */
  AGENT_RESPONSE_DELAYS: z.string().optional()
});
export type AgentEnv = z.infer<typeof EnvSchema>;

export function loadAgentEnv(env: Record<string, string | undefined>): AgentEnv {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Missing or invalid agent Lambda environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`
    );
  }
  return parsed.data;
}

export function createAgentServices(env: AgentEnv): Services {
  const table = { doc: createDocumentClient(), tableName: env.TABLE_NAME };
  return createServices({
    clock: systemClock,
    repos: createDynamoRepos(table),
    // Without this the services fall back to an empty in-memory store: no schedule (every player on
    // bye), projections, stats, or news for the agents' tools.
    reference: createDynamoReferenceStore(table),
    events: new EventBridgePublisher({ busName: env.EVENT_BUS_NAME }),
    log: createLogger({ level: env.LOG_LEVEL })
  });
}

export function isFakeModel(env: Pick<AgentEnv, 'FANTASY_FAKE_MODEL'>): boolean {
  return env.FANTASY_FAKE_MODEL === '1' || env.FANTASY_FAKE_MODEL === 'true';
}

/** True unless `AGENT_RESPONSE_DELAYS` turns the router's response delays off. */
export function responseDelaysOn(env: Pick<AgentEnv, 'AGENT_RESPONSE_DELAYS'>): boolean {
  const flag = env.AGENT_RESPONSE_DELAYS?.trim().toLowerCase();
  return flag !== 'off' && flag !== '0' && flag !== 'false';
}

/** The fake model when `FANTASY_FAKE_MODEL=1`; otherwise Bedrock (loaded lazily, so fake mode never loads the SDK). */
export async function modelFromEnv(env: Pick<AgentEnv, 'FANTASY_FAKE_MODEL'>): Promise<ModelClient> {
  if (isFakeModel(env)) return new ScriptedModelClient();
  const { StrandsModelClient } = await import('../strands-model.js');
  return new StrandsModelClient();
}

export function killSwitchFromEnv(
  env: Pick<AgentEnv, 'AGENT_KILL_SWITCH_PARAM'>,
  services: Services
): KillSwitch {
  if (env.AGENT_KILL_SWITCH_PARAM === undefined) return OFF_SWITCH;
  return new ParameterKillSwitch({
    name: env.AGENT_KILL_SWITCH_PARAM,
    reader: ssmParameterReader(),
    clock: services.clock,
    log: services.log
  });
}
