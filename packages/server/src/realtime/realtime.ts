/**
 * Realtime (issue #68): league updates pushed to browsers over Momento Topics.
 *
 * The server publishes to one topic per league (and one global topic for events that are not tied
 * to a league, such as live stat updates). Browsers never see the Momento API key: `get_realtime_token`
 * vends a short-lived token that can only subscribe to those topics. When realtime is not configured
 * (local dev, tests, CI) the no-op implementation is used and the app polls instead.
 */

export const GLOBAL_TOPIC = 'fantasy.global';

export function leagueTopic(leagueId: string): string {
  return `fantasy.league.${leagueId}`;
}

/** What subscribers receive, as JSON. */
export type RealtimeMessage =
  | { type: 'chat'; leagueId: string; message: Record<string, unknown> }
  | {
      type: 'event';
      detailType: string;
      eventId: string;
      time: string | null;
      leagueId: string | null;
      detail: Record<string, unknown>;
    };

export interface RealtimeTokenRequest {
  leagueId: string;
  /** Who the token is for (`user#<sub>`); Momento reports it as the token id. */
  subscriber: string;
  ttlSeconds: number;
}

export interface RealtimeToken {
  token: string;
  /** The Momento endpoint the token is for, when the SDK reports one. */
  endpoint: string | null;
  cacheName: string;
  topics: { league: string; global: string };
  expiresAt: string;
}

export interface Realtime {
  /** A subscribe-only token for the league's topics, or null when realtime is not configured. */
  issueSubscribeToken(request: RealtimeTokenRequest): Promise<RealtimeToken | null>;
  /** Publishes to a topic. A no-op when realtime is not configured. */
  publish(topic: string, message: RealtimeMessage): Promise<void>;
}

/** Realtime is off: no tokens, and publishes are recorded (for tests) but go nowhere. */
export class InMemoryRealtime implements Realtime {
  readonly published: { topic: string; message: RealtimeMessage }[] = [];

  async issueSubscribeToken(): Promise<RealtimeToken | null> {
    return null;
  }

  async publish(topic: string, message: RealtimeMessage): Promise<void> {
    this.published.push({ topic, message: structuredClone(message) });
  }
}
