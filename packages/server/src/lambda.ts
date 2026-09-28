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
import { createCognitoVerifier } from './auth/verifier.js';
import { loadLambdaConfig } from './config.js';
import { EventBridgePublisher } from './events/eventbridge.js';
import { createApp } from './http/app.js';
import { createLogger } from './log.js';
import { registry } from './operations/index.js';
import { createDynamoRepos } from './repos/dynamo/index.js';
import { createDynamoReferenceStore } from './repos/dynamo/reference.js';
import { createDocumentClient } from './repos/dynamo/table.js';
import { limitsFromEnv } from './context.js';
import { realtimeFromEnv } from './realtime/config.js';
import { createServices } from './services.js';

export type FunctionUrlEvent = Extract<LambdaEvent, { rawPath: string }>;

/** Builds the production app from environment variables. */
export function createLambdaApp(env: Record<string, string | undefined> = process.env): Hono {
  const config = loadLambdaConfig(env);
  const log = createLogger({ level: config.logLevel });
  const table = { doc: createDocumentClient(), tableName: config.tableName };
  const repos = createDynamoRepos(table);
  const services = createServices({
    clock: systemClock,
    repos,
    events: new EventBridgePublisher({ busName: config.eventBusName }),
    log,
    limits: limitsFromEnv(env),
    reference: createDynamoReferenceStore(table),
    realtime: realtimeFromEnv(env, { clock: systemClock, log })
  });
  const verifier = createCognitoVerifier({
    userPoolId: config.userPoolId,
    clientId: config.userPoolClientId
  });
  return createApp({ registry, services, verifier });
}

let cached: ((event: FunctionUrlEvent, context?: LambdaContext) => Promise<APIGatewayProxyResult>) | null =
  null;

export async function handler(
  event: FunctionUrlEvent,
  context?: LambdaContext
): Promise<APIGatewayProxyResult> {
  cached ??= handle(createLambdaApp());
  return cached(event, context);
}
