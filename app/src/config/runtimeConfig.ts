/**
 * Runtime configuration: which Cognito app client the SPA signs in with.
 *
 * The build is environment-agnostic. `make deploy-frontend` writes
 * `/auth-config.json` into the bucket from the stack's outputs (UserPoolId,
 * UserPoolClientId), so Staging and Production ship the same bundle and a
 * client id change needs no rebuild. This is the async loader pattern from
 * `@readysetcloud/ui/auth` (`configureAuth(async () => ...)`).
 *
 * For local dev without that file, `VITE_COGNITO_REGION` and
 * `VITE_COGNITO_CLIENT_ID` are used instead (see `make dev-auth-config` for a
 * way to write the file from a deployed stack).
 */

export const RUNTIME_CONFIG_PATH = '/auth-config.json';

export interface RuntimeConfig {
  region: string;
  userPoolId?: string;
  clientId: string;
}

type Env = Record<string, string | boolean | undefined>;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Narrow an unknown JSON document to a usable config, or null. */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!nonEmpty(record.region) || !nonEmpty(record.clientId)) return null;
  const config: RuntimeConfig = { region: record.region.trim(), clientId: record.clientId.trim() };
  if (nonEmpty(record.userPoolId)) config.userPoolId = record.userPoolId.trim();
  return config;
}

/** Build-time fallback from `VITE_COGNITO_*` variables, or null. */
export function configFromEnv(env: Env): RuntimeConfig | null {
  return parseRuntimeConfig({
    region: env.VITE_COGNITO_REGION,
    clientId: env.VITE_COGNITO_CLIENT_ID,
    userPoolId: env.VITE_COGNITO_USER_POOL_ID
  });
}

/**
 * Fetch `/auth-config.json`; fall back to the build-time env; null when
 * neither is usable. Never throws: a missing config shows a notice on the
 * sign-in page rather than a blank app.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  env: Env = import.meta.env
): Promise<RuntimeConfig | null> {
  try {
    const response = await fetchImpl(RUNTIME_CONFIG_PATH, {
      headers: { accept: 'application/json' },
      cache: 'no-store'
    });
    // A dev server answers unknown paths with index.html; only trust JSON.
    const type = response.headers.get('content-type') ?? '';
    if (response.ok && type.includes('json')) {
      const parsed = parseRuntimeConfig(await response.json());
      if (parsed) return parsed;
    }
  } catch {
    // Offline or blocked: fall through to the env.
  }
  return configFromEnv(env);
}
