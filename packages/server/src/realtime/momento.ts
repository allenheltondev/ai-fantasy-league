import type { Clock } from '@fantasy/core';
import {
  GLOBAL_TOPIC,
  leagueTopic,
  type Realtime,
  type RealtimeMessage,
  type RealtimeToken,
  type RealtimeTokenRequest
} from './realtime.js';

/**
 * Momento Topics (docs/ARCHITECTURE.md, "Realtime"). The SDK sits behind two small interfaces so
 * the realtime logic is testable without credentials, and so the gRPC SDK is loaded only when
 * realtime is actually configured.
 */

export interface MomentoTopicPublisher {
  publish(cacheName: string, topic: string, value: string): Promise<void>;
}

export interface MomentoTokenVendor {
  /** A disposable token that may only subscribe to `topics` in `cacheName`. */
  subscribeOnlyToken(input: {
    cacheName: string;
    topics: readonly string[];
    ttlSeconds: number;
    tokenId: string;
  }): Promise<{ token: string; endpoint: string | null; expiresAtEpochSeconds: number }>;
}

export interface MomentoClients {
  topics: MomentoTopicPublisher;
  tokens: MomentoTokenVendor;
}

/** Momento caps disposable tokens at one hour. */
export const MAX_TOKEN_TTL_SECONDS = 3600;

export class MomentoRealtime implements Realtime {
  constructor(private readonly options: { clients: MomentoClients; cacheName: string; clock: Clock }) {}

  async issueSubscribeToken(request: RealtimeTokenRequest): Promise<RealtimeToken> {
    const topics = { league: leagueTopic(request.leagueId), global: GLOBAL_TOPIC };
    const ttlSeconds = Math.min(Math.max(60, Math.floor(request.ttlSeconds)), MAX_TOKEN_TTL_SECONDS);
    const issued = await this.options.clients.tokens.subscribeOnlyToken({
      cacheName: this.options.cacheName,
      topics: [topics.league, topics.global],
      ttlSeconds,
      tokenId: request.subscriber
    });
    const fallbackExpiry = this.options.clock.now().getTime() + ttlSeconds * 1000;
    const expiresAtMs = Number.isFinite(issued.expiresAtEpochSeconds)
      ? issued.expiresAtEpochSeconds * 1000
      : fallbackExpiry;
    return {
      token: issued.token,
      endpoint: issued.endpoint,
      cacheName: this.options.cacheName,
      topics,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async publish(topic: string, message: RealtimeMessage): Promise<void> {
    await this.options.clients.topics.publish(this.options.cacheName, topic, JSON.stringify(message));
  }
}

/** Builds the SDK clients from the Momento API key (rsc-core's `momento` secret). */
export async function createMomentoClients(apiKey: string): Promise<MomentoClients> {
  const sdk = await import('@gomomento/sdk');
  const credentialProvider = sdk.CredentialProvider.fromString({ apiKey });
  const topicClient = new sdk.TopicClient({
    configuration: sdk.TopicConfigurations.Lambda.latest(),
    credentialProvider
  });
  const authClient = new sdk.AuthClient({ credentialProvider });
  return {
    topics: {
      async publish(cacheName, topic, value) {
        const response = await topicClient.publish(cacheName, topic, value);
        if (response instanceof sdk.TopicPublish.Error) {
          throw new Error(`Momento publish to ${topic} failed: ${response.message()}`);
        }
      }
    },
    tokens: {
      async subscribeOnlyToken({ cacheName, topics, ttlSeconds, tokenId }) {
        const scope = {
          permissions: topics.map((topic) => ({ role: sdk.TopicRole.SubscribeOnly, cache: cacheName, topic }))
        };
        const response = await authClient.generateDisposableToken(scope, sdk.ExpiresIn.seconds(ttlSeconds), {
          tokenId
        });
        if (!(response instanceof sdk.GenerateDisposableToken.Success)) {
          throw new Error(`Momento token request failed: ${response.message()}`);
        }
        return {
          token: response.authToken,
          endpoint: response.endpoint,
          expiresAtEpochSeconds: response.expiresAt.epoch()
        };
      }
    }
  };
}
