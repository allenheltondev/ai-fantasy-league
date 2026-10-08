import { getFreshIdToken } from '@readysetcloud/ui/auth';
import type { ChatMessage, RealtimeInfo } from './api';

/**
 * Live chat over AWS AppSync Events. The API hands out the endpoint and channels
 * (get_realtime_config), and the browser subscribes with its own Cognito ID token; the client
 * (`../realtime/appsyncEvents`) is loaded only when realtime is on, so local dev and e2e (where the
 * API reports `enabled: false`) never download it.
 */

export interface LiveTarget {
  httpHost: string;
  realtimeHost: string;
  /** The league channel, and the caller's team channel (where their DMs arrive) when they have a seat. */
  channels: string[];
}

/** Opens a subscription and resolves to a function that closes it. */
export type Connect = (
  target: LiveTarget,
  handlers: { onChat(message: ChatMessage): void; onError(): void }
) => Promise<() => void>;

/** The subscription target when realtime is on and the config is complete, else null. */
export function liveTarget(info: RealtimeInfo): LiveTarget | null {
  if (!info.enabled || info.httpHost === null || info.realtimeHost === null || info.channels === null) {
    return null;
  }
  const team = info.channels.team ?? null;
  return {
    httpHost: info.httpHost,
    realtimeHost: info.realtimeHost,
    channels: [info.channels.league, ...(team === null ? [] : [team])]
  };
}

/** The signed-in person's ID token, which every subscribe carries. */
export async function subscribeToken(): Promise<string> {
  const token = await getFreshIdToken();
  if (token === null) throw new Error('Sign in to get live updates.');
  return token;
}

/** The chat message in a channel event, or null for other league events and anything malformed. */
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

export const connectLiveChat: Connect = async (target, handlers) => {
  const token = await subscribeToken();
  const { subscribeChannels } = await import('../realtime/appsyncEvents');
  return subscribeChannels(target, token, {
    onData: (raw) => {
      const message = parseChatItem(raw);
      if (message !== null) handlers.onChat(message);
    },
    onError: () => handlers.onError()
  });
};
