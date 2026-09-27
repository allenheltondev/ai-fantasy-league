import type { TokenVerifier } from './verifier.js';
import { unauthenticated } from './verifier.js';

/**
 * Local development sign-in. Only `src/local.ts` imports this module, and it only
 * turns on when FANTASY_LOCAL_AUTH=1 outside Lambda. Inside Lambda
 * (AWS_LAMBDA_FUNCTION_NAME is set) it can never be enabled.
 */
export function isLocalAuthEnabled(env: Record<string, string | undefined>): boolean {
  if (env.AWS_LAMBDA_FUNCTION_NAME !== undefined && env.AWS_LAMBDA_FUNCTION_NAME !== '') return false;
  return env.FANTASY_LOCAL_AUTH === '1';
}

const DEV_TOKEN = /^dev(?::([a-z0-9-]{1,40}))?$/;

/**
 * Accepts `Bearer dev` (user `local-dev`) or `Bearer dev:<handle>` (user
 * `local-<handle>`), so e2e tests can sign in as several people.
 */
export function createDevVerifier(env: Record<string, string | undefined>): TokenVerifier {
  if (!isLocalAuthEnabled(env)) {
    throw new Error('Local auth is disabled: it needs FANTASY_LOCAL_AUTH=1 and cannot run inside Lambda.');
  }
  return {
    async verify(token) {
      const match = DEV_TOKEN.exec(token);
      if (match === null) throw unauthenticated('Local dev tokens look like "dev" or "dev:<handle>".');
      const handle = match[1] ?? 'dev';
      return Object.freeze({
        type: 'user',
        sub: `local-${handle}`,
        email: `${handle}@localhost`,
        name: handle === 'dev' ? 'Local Dev' : handle
      });
    }
  };
}
