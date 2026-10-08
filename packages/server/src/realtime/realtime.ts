import { createHash } from 'node:crypto';
import { seatTenureStart, type Team } from '../repos/types.js';

/**
 * Realtime (issue #68, ADR 010 in docs/adr): league updates pushed to browsers over AWS AppSync Events.
 *
 * The server publishes to channels in one namespace (`fantasy`): one per league, one per team seat
 * tenure (results only that team's current occupant may see), and one global channel for events
 * that are not tied to a league, such as live stat updates. Browsers subscribe with their Cognito ID
 * token, and the namespace's subscribe handler (`authorizer.ts`) checks current league state on every
 * subscribe; only the server publishes (IAM). When realtime is not configured (local dev, tests, CI)
 * the no-op implementation is used and the app polls instead.
 */

/** The AppSync Events channel namespace every channel lives in. */
export const CHANNEL_NAMESPACE = 'fantasy';

export const GLOBAL_CHANNEL = `/${CHANNEL_NAMESPACE}/global`;

export function leagueChannel(leagueId: string): string {
  return `/${CHANNEL_NAMESPACE}/league/${leagueId}`;
}

/**
 * One team's private channel for its current occupant: results only that team should see (its
 * waiver claim outcomes, trade offers it sent or received, its DMs and inbox items).
 *
 * The last segment is the seat's tenure key (`seatTenureKey`). AppSync Events cannot close a
 * subscription that is already open, so when the seat changes hands the relay starts publishing to
 * a new channel: the person who left keeps a socket on a channel nobody publishes to any more, and
 * the subscribe check refuses them the new one.
 */
export function teamChannel(leagueId: string, teamId: string, tenureKey: string): string {
  return `/${CHANNEL_NAMESPACE}/team/${leagueId}/${teamId}/${tenureKey}`;
}

/**
 * A short, opaque key for the team's current seat tenure: who holds the seat and since when. It
 * changes whenever the seat changes hands (`claimSeat`, `vacateSeat`, `set_seat_type` all move
 * `occupiedSince`), and is the same for every reader of the team in between.
 */
export function seatTenureKey(
  team: Pick<Team, 'leagueId' | 'id' | 'ownerUserId' | 'occupiedSince' | 'createdAt'>
): string {
  return createHash('sha256')
    .update([team.leagueId, team.id, team.ownerUserId ?? '', seatTenureStart(team)].join('\n'))
    .digest('hex')
    .slice(0, 16);
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

/** Where browsers connect: the AppSync Events API's DNS names. */
export interface RealtimeEndpoint {
  /** The HTTP domain: browsers name it as `host` in their subscribe authorization. */
  httpHost: string;
  /** The WebSocket domain (`wss://<realtimeHost>/event/realtime`). */
  realtimeHost: string;
}

export interface Realtime {
  /** Where browsers subscribe, or null when realtime is not configured (the app polls). */
  endpoint(): RealtimeEndpoint | null;
  /** Publishes to a channel. A no-op when realtime is not configured. */
  publish(channel: string, message: RealtimeMessage): Promise<void>;
}

/** Realtime is off: no endpoint, and publishes are recorded (for tests) but go nowhere. */
export class InMemoryRealtime implements Realtime {
  readonly published: { channel: string; message: RealtimeMessage }[] = [];

  endpoint(): RealtimeEndpoint | null {
    return null;
  }

  async publish(channel: string, message: RealtimeMessage): Promise<void> {
    this.published.push({ channel, message: structuredClone(message) });
  }
}
