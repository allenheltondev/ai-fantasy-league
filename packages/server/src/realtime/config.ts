import { AppSyncEventsRealtime, sigV4Signer, type AwsCredentials, type HttpPost } from './appsync.js';
import { InMemoryRealtime, type Realtime, type RealtimeEndpoint } from './realtime.js';

/**
 * Where the AppSync Events settings come from: the Event API's DNS names, which the template passes
 * to the API and the relay (`REALTIME_HTTP_DOMAIN`, `REALTIME_WS_DOMAIN`, from `RealtimeApi.Dns`),
 * and the Lambda's own `AWS_REGION` for signing. There is no key: the relay publishes with its IAM
 * role and browsers subscribe with their Cognito ID token.
 *
 * Realtime is on only when both domains are set. Local dev, tests, and CI set neither, so nothing
 * there needs a realtime service.
 */
export interface RealtimeSettings extends RealtimeEndpoint {
  region: string;
}

const nonEmpty = (value: string | undefined) =>
  value !== undefined && value.trim().length > 0 ? value.trim() : undefined;

export function realtimeSettingsFromEnv(env: Record<string, string | undefined>): RealtimeSettings | null {
  const httpHost = nonEmpty(env.REALTIME_HTTP_DOMAIN);
  const realtimeHost = nonEmpty(env.REALTIME_WS_DOMAIN);
  if (httpHost === undefined || realtimeHost === undefined) return null;
  return { httpHost, realtimeHost, region: nonEmpty(env.AWS_REGION) ?? 'us-east-1' };
}

/** AppSync Events when the environment configures it, otherwise the no-op implementation. */
export function realtimeFromEnv(
  env: Record<string, string | undefined>,
  seams: { credentials?: () => Promise<AwsCredentials>; post?: HttpPost } = {}
): Realtime {
  const settings = realtimeSettingsFromEnv(env);
  if (settings === null) return new InMemoryRealtime();
  const { region, ...endpoint } = settings;
  return new AppSyncEventsRealtime({
    endpoint,
    sign: sigV4Signer({
      region,
      ...(seams.credentials === undefined ? {} : { credentials: seams.credentials })
    }),
    ...(seams.post === undefined ? {} : { post: seams.post })
  });
}
