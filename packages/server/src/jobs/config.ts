import { z } from 'zod';
import { parseLogLevel, type LogLevel } from '../log.js';

/** Environment the data jobs Lambda needs. Infra sets these on DataJobsFunction. */
const JobsEnvSchema = z.object({
  TABLE_NAME: z.string().min(1),
  EVENT_BUS_NAME: z.string().min(1).default('default'),
  SLEEPER_BASE_URL: z.url().optional(),
  /** SSM parameter holding the news feed list (`defaults`, JSON, or one URL per line). */
  NEWS_FEEDS_PARAMETER: z.string().min(1).optional(),
  /** Inline feed list, used when no parameter is configured (local runs). */
  NEWS_FEEDS: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  /** `true` reports league achievements to the rsc-core badge chest (`Track Activity` events). */
  BADGE_CHEST_ENABLED: z.string().optional()
});

export interface JobsConfig {
  tableName: string;
  eventBusName: string;
  sleeperBaseUrl: string | undefined;
  newsFeedsParameter: string | undefined;
  newsFeeds: string | undefined;
  logLevel: LogLevel;
  badgeChest: boolean;
}

export function loadJobsConfig(env: Record<string, string | undefined>): JobsConfig {
  const parsed = JobsEnvSchema.safeParse(env);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Missing or invalid data jobs environment: ${bad}`);
  }
  return {
    tableName: parsed.data.TABLE_NAME,
    eventBusName: parsed.data.EVENT_BUS_NAME,
    sleeperBaseUrl: parsed.data.SLEEPER_BASE_URL,
    newsFeedsParameter: parsed.data.NEWS_FEEDS_PARAMETER,
    newsFeeds: parsed.data.NEWS_FEEDS,
    logLevel: parseLogLevel(parsed.data.LOG_LEVEL),
    badgeChest: parsed.data.BADGE_CHEST_ENABLED === 'true'
  };
}
