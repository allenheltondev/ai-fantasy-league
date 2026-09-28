import { z } from 'zod';
import { parseLogLevel, type LogLevel } from './log.js';

/** Environment the Lambda needs. Infra sets these on the function. */
const LambdaEnvSchema = z.object({
  TABLE_NAME: z.string().min(1),
  USER_POOL_ID: z.string().min(1),
  USER_POOL_CLIENT_ID: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1).default('default'),
  // CloudFront's origin-verify secret (http/origin.ts). Required so the API never runs open.
  ORIGIN_VERIFY_SECRET: z.string().trim().min(1),
  LOG_LEVEL: z.string().optional()
});

export interface LambdaConfig {
  tableName: string;
  userPoolId: string;
  userPoolClientId: string;
  eventBusName: string;
  logLevel: LogLevel;
}

export function loadLambdaConfig(env: Record<string, string | undefined>): LambdaConfig {
  const parsed = LambdaEnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Missing or invalid Lambda environment: ${missing}`);
  }
  return {
    tableName: parsed.data.TABLE_NAME,
    userPoolId: parsed.data.USER_POOL_ID,
    userPoolClientId: parsed.data.USER_POOL_CLIENT_ID,
    eventBusName: parsed.data.EVENT_BUS_NAME,
    logLevel: parseLogLevel(parsed.data.LOG_LEVEL)
  };
}
