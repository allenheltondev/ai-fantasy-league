import type { ChatMessage, RealtimeInfo } from './api';

/**
 * Live chat over Momento Topics (@gomomento/sdk-web). The API vends a short-lived, subscribe-only
 * token (get_realtime_token); the SDK is loaded only when realtime is on, so local dev and e2e (where
 * the API reports `enabled: false`) never download it.
 */

export interface LiveTarget {
  token: string;
  cacheName: string;
  /** The league topic, and the caller's team topic (where their DMs arrive) when they have a seat. */
  topics: string[];
}

/** Opens a subscription and resolves to a function that closes it. */
export type Connect = (
  target: LiveTarget,
  handlers: { onChat(message: ChatMessage): void; onError(): void }
) => Promise<() => void>;

/** The subscription target when realtime is on and the token is complete, else null. */
export function liveTarget(info: RealtimeInfo): LiveTarget | null {
  if (!info.enabled || info.token === null || info.cacheName === null || info.topics === null) return null;
  const team = info.topics.team ?? null;
  return {
    token: info.token,
    cacheName: info.cacheName,
    topics: [info.topics.league, ...(team === null ? [] : [team])]
  };
}

/** The chat message in a topic item, or null for other league events and anything malformed. */
export function parseChatItem(raw: string): ChatMessage | null {
  try {
    const value = JSON.parse(raw) as { type?: unknown; message?: unknown };
    if (value.type !== 'chat' || value.message === null || typeof value.message !== 'object') return null;
    const message = value.message as Partial<ChatMessage>;
    return typeof message.id === 'string' &&
      typeof message.text === 'string' &&
      typeof message.createdAt === 'string'
      ? (message as ChatMessage)
      : null;
  } catch {
    return null;
  }
}

export const connectMomento: Connect = async (target, handlers) => {
  const sdk = await import('@gomomento/sdk-web');
  const client = new sdk.TopicClient({
    configuration: sdk.TopicConfigurations.Browser.latest(),
    credentialProvider: sdk.CredentialProvider.fromDisposableToken({ authToken: target.token })
  });
  const closers: (() => void)[] = [];
  const closeAll = () => closers.forEach((close) => close());
  for (const topic of target.topics) {
    const subscription = await client.subscribe(target.cacheName, topic, {
      onItem: (item) => {
        const message = parseChatItem(item.valueString());
        if (message !== null) handlers.onChat(message);
      },
      onError: () => handlers.onError()
    });
    if (!(subscription instanceof sdk.TopicSubscribe.Subscription)) {
      closeAll();
      throw new Error('Could not subscribe to live chat.');
    }
    closers.push(() => subscription.unsubscribe());
  }
  return closeAll;
};
