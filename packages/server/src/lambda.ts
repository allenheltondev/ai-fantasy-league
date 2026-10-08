/**
 * Lambda entrypoint for the API. CloudFront `/api/*` → Lambda Function URL (OAC),
 * so events arrive in the Function URL (API Gateway v2 payload) format.
 *
 * Infra bundles exactly this file and export: `packages/server/src/lambda.ts#handler`.
 * This module must never import the local dev auth bypass (`auth/dev.ts`).
 */
import { systemClock } from '@fantasy/core';
import type { Hono } from 'hono';
import { handle, type APIGatewayProxyResult, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { killSwitchFromParameter } from './agents/kill-switch.js';
import { createCognitoVerifier } from './auth/verifier.js';
import { loadLambdaConfig } from './config.js';
import { EventBridgePublisher } from './events/eventbridge.js';
import { createApp } from './http/app.js';
import { originSecretsFromEnv } from './http/origin.js';
import { createLogger } from './log.js';
import { registry } from './operations/index.js';
import { createDynamoRepos } from './repos/dynamo/index.js';
import { createDynamoReferenceStore } from './repos/dynamo/reference.js';
import { createDocumentClient } from './repos/dynamo/table.js';
import { limitsFromEnv } from './context.js';
import { realtimeFromEnv } from './realtime/config.js';
import { createServices } from './services.js';
import type { Services } from './context.js';
import { handleLeagueEvent, isBusEvent, type LeagueBusEvent } from './events/handlers.js';

export type FunctionUrlEvent = Extract<LambdaEvent, { rawPath: string }>;

/** Production services from environment variables. */
export function createLambdaServices(env: Record<string, string | undefined> = process.env): Services {
  const config = loadLambdaConfig(env);
  const log = createLogger({ level: config.logLevel });
  const table = { doc: createDocumentClient(), tableName: config.tableName };
  const repos = createDynamoRepos(table);
  return createServices({
    clock: systemClock,
    repos,
    events: new EventBridgePublisher({ busName: config.eventBusName }),
    log,
    limits: limitsFromEnv(env),
    reference: createDynamoReferenceStore(table),
    realtime: realtimeFromEnv(env),
    agentKillSwitch: killSwitchFromParameter(env.AGENT_KILL_SWITCH_PARAM, { clock: systemClock, log })
  });
}

/** Builds the production app from environment variables. */
export function createLambdaApp(env: Record<string, string | undefined> = process.env): Hono {
  const config = loadLambdaConfig(env);
  const services = createLambdaServices(env);
  const verifier = createCognitoVerifier({
    userPoolId: config.userPoolId,
    clientId: config.userPoolClientId
  });
  // Behind CloudFront only: requests without the origin-verify header are refused (fails closed
  // when the secret is missing, see loadLambdaConfig).
  return createApp({ registry, services, verifier, originSecrets: originSecretsFromEnv(env) });
}

let cached: ((event: FunctionUrlEvent, context?: LambdaContext) => Promise<APIGatewayProxyResult>) | null =
  null;
let cachedServices: Services | null = null;

/**
 * Function URL requests go to the REST app; EventBridge events (the draft pick clock) go to the
 * league event handlers.
 */
export async function handler(
  event: FunctionUrlEvent,
  context?: LambdaContext
): Promise<APIGatewayProxyResult>;
export async function handler(event: LeagueBusEvent): Promise<{ handled: boolean }>;
export async function handler(
  event: FunctionUrlEvent | LeagueBusEvent,
  context?: LambdaContext
): Promise<APIGatewayProxyResult | { handled: boolean }> {
  if (isBusEvent(event)) {
    cachedServices ??= createLambdaServices();
    return handleLeagueEvent(cachedServices, event);
  }
  cached ??= handle(createLambdaApp());
  return cached(event, context);
}
