import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../errors.js';

/**
 * CloudFront adds this header, holding a deploy-time secret, to every request it sends to the API's
 * Lambda Function URL (infra/template.yaml, the `api` origin). A request without it reached the
 * Function URL directly, around CloudFront, and is refused before authentication runs.
 */
export const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

/**
 * The secrets the API accepts: the current one and, during a rotation, the previous one. Blank
 * entries are dropped. Read once, when the Lambda app is built (cold start).
 */
export function originSecretsFromEnv(env: Record<string, string | undefined>): string[] {
  return [env.ORIGIN_VERIFY_SECRET, env.ORIGIN_VERIFY_SECRET_PREVIOUS]
    .map((value) => value?.trim() ?? '')
    .filter((value, index, all) => value !== '' && all.indexOf(value) === index);
}

function matches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Rejects (403) every request whose origin-verify header matches none of `secrets`. */
export function requireOriginSecret(secrets: readonly string[]): MiddlewareHandler {
  if (secrets.length === 0) throw new Error('requireOriginSecret needs at least one secret.');
  return async (c, next) => {
    const presented = c.req.header(ORIGIN_VERIFY_HEADER) ?? '';
    if (!secrets.some((secret) => matches(presented, secret))) {
      throw new ApiError('FORBIDDEN', 'This API only accepts requests through the app URL.', {
        fix: 'Call the API at the app URL (https://<app domain>/api/v1/...), not the Lambda Function URL directly.'
      });
    }
    await next();
  };
}
