import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { Clock } from '@fantasy/core';
import type { Logger } from '../log.js';
import { createMomentoClients, MomentoRealtime, type MomentoClients } from './momento.js';
import {
  InMemoryRealtime,
  type Realtime,
  type RealtimeMessage,
  type RealtimeToken,
  type RealtimeTokenRequest
} from './realtime.js';

/**
 * Where the Momento settings come from. Following rsc-core, the API key is the `momento` field of
 * the shared Secrets Manager secret, whose ARN is in the `/readysetcloud/secrets` SSM parameter
 * (`SECRET_ID` is that ARN, resolved at deploy time; `SECRETS_PARAMETER_NAME` is the parameter
 * itself), and the cache is rsc-core's default cache (`/readysetcloud/cache-name`).
 *
 * Realtime is on only when both a key source and a cache source are set. Local dev, tests, and CI
 * set neither, so nothing there needs Momento credentials.
 *
 * - `MOMENTO_API_KEY` / `MOMENTO_CACHE_NAME`: direct values (a developer's own Momento account).
 * - `SECRET_ID` or `SECRETS_PARAMETER_NAME`: the rsc-core secret (by ARN, or via the parameter).
 * - `MOMENTO_CACHE_PARAMETER`: SSM parameter holding the cache name.
 */
export interface RealtimeSources {
  apiKey?: string;
  secretId?: string;
  secretsParameter?: string;
  cacheName?: string;
  cacheParameter?: string;
}

const nonEmpty = (value: string | undefined) =>
  value !== undefined && value.trim().length > 0 ? value.trim() : undefined;

export function realtimeSourcesFromEnv(env: Record<string, string | undefined>): RealtimeSources | null {
  const sources: RealtimeSources = {};
  const set = (key: keyof RealtimeSources, value: string | undefined) => {
    const v = nonEmpty(value);
    if (v !== undefined) sources[key] = v;
  };
  set('apiKey', env.MOMENTO_API_KEY);
  set('secretId', env.SECRET_ID);
  set('secretsParameter', env.SECRETS_PARAMETER_NAME);
  set('cacheName', env.MOMENTO_CACHE_NAME);
  set('cacheParameter', env.MOMENTO_CACHE_PARAMETER);
  const hasKey = sources.apiKey ?? sources.secretId ?? sources.secretsParameter;
  const hasCache = sources.cacheName ?? sources.cacheParameter;
  return hasKey === undefined || hasCache === undefined ? null : sources;
}

/** The AWS reads realtime needs, behind an interface so tests pass fakes. */
export interface ConfigReader {
  parameter(name: string): Promise<string | undefined>;
  secret(secretId: string): Promise<string | undefined>;
}

export function awsConfigReader(): ConfigReader {
  const ssm = new SSMClient({});
  const secrets = new SecretsManagerClient({});
  return {
    async parameter(name) {
      const result = await ssm.send(new GetParameterCommand({ Name: name }));
      return result.Parameter?.Value;
    },
    async secret(secretId) {
      const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
      return result.SecretString;
    }
  };
}

/** Resolves the API key and cache name from the configured sources. */
export async function resolveMomentoSettings(
  sources: RealtimeSources,
  reader: ConfigReader
): Promise<{ apiKey: string; cacheName: string }> {
  let apiKey = sources.apiKey;
  if (apiKey === undefined) {
    const secretId = sources.secretId ?? (await reader.parameter(sources.secretsParameter as string));
    if (secretId === undefined) throw new Error('The secrets parameter has no value.');
    const raw = await reader.secret(secretId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw ?? 'null');
    } catch {
      parsed = null;
    }
    const value =
      parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>).momento : null;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('The shared secret has no "momento" API key.');
    }
    apiKey = value;
  }
  const cacheName = sources.cacheName ?? (await reader.parameter(sources.cacheParameter as string));
  if (cacheName === undefined || cacheName.length === 0)
    throw new Error('The Momento cache name is not set.');
  return { apiKey, cacheName };
}

export interface LazyRealtimeOptions {
  sources: RealtimeSources;
  clock: Clock;
  log: Logger;
  reader?: ConfigReader;
  clients?: (apiKey: string) => Promise<MomentoClients>;
}

/**
 * Momento, set up on first use (secrets are read once per container). If setup fails, tokens are
 * not issued (the app polls) and publishes throw so the event is retried; the next call tries again.
 */
export class LazyMomentoRealtime implements Realtime {
  #inner: Promise<MomentoRealtime> | null = null;

  constructor(private readonly options: LazyRealtimeOptions) {}

  #load(): Promise<MomentoRealtime> {
    this.#inner ??= (async () => {
      const { apiKey, cacheName } = await resolveMomentoSettings(
        this.options.sources,
        this.options.reader ?? awsConfigReader()
      );
      const clients = await (this.options.clients ?? createMomentoClients)(apiKey);
      return new MomentoRealtime({ clients, cacheName, clock: this.options.clock });
    })().catch((error: unknown) => {
      this.#inner = null;
      throw error;
    });
    return this.#inner;
  }

  async issueSubscribeToken(request: RealtimeTokenRequest): Promise<RealtimeToken | null> {
    try {
      return await (await this.#load()).issueSubscribeToken(request);
    } catch (error) {
      this.options.log.error('realtime token unavailable; the app will poll', { error });
      return null;
    }
  }

  async publish(topic: string, message: RealtimeMessage): Promise<void> {
    await (await this.#load()).publish(topic, message);
  }
}

/** Momento when the environment configures it, otherwise the no-op implementation. */
export function realtimeFromEnv(
  env: Record<string, string | undefined>,
  options: Omit<LazyRealtimeOptions, 'sources'>
): Realtime {
  const sources = realtimeSourcesFromEnv(env);
  return sources === null ? new InMemoryRealtime() : new LazyMomentoRealtime({ ...options, sources });
}
