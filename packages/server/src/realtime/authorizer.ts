import type { UserPrincipal } from '../auth/principal.js';
import { isOutsider, resolveActor } from '../league/phase.js';
import type { Logger } from '../log.js';
import type { LeagueRepository, TeamRepository } from '../repos/types.js';
import { CHANNEL_NAMESPACE, seatTenureKey } from './realtime.js';

/**
 * Who may subscribe to which channel (docs/adr, ADR 010). The `fantasy`
 * channel namespace's OnSubscribe handler is a direct Lambda integration: AppSync Events has already
 * verified the caller's Cognito ID token, and this checks the channel against current league state
 * on every subscribe (and so on every reconnect):
 *
 * - `/fantasy/global`: any signed-in person.
 * - `/fantasy/league/<leagueId>`: a member of the league (a seat holder, or the commissioner), as
 *   `requireMember` decides for the API.
 * - `/fantasy/team/<leagueId>/<teamId>/<tenureKey>`: the team's current owner, and only for the
 *   current tenure key. Someone who has left the seat is refused, and so is anyone holding a stale
 *   key from before a seat change.
 *
 * Anything else, wildcards (`/fantasy/*`) included, is refused. Publishing is IAM only and never
 * reaches this handler.
 */

/** A channel segment AppSync allows, and that our ids use: letters, digits, and dashes. */
const SEGMENT = /^[A-Za-z0-9-]{1,50}$/;

export type ChannelRef =
  | { kind: 'global' }
  | { kind: 'league'; leagueId: string }
  | { kind: 'team'; leagueId: string; teamId: string; tenureKey: string };

export function parseChannel(path: string): ChannelRef | null {
  const [root, namespace, kind, ...rest] = path.split('/');
  if (root !== '' || namespace !== CHANNEL_NAMESPACE || !rest.every((s) => SEGMENT.test(s))) return null;
  if (kind === 'global' && rest.length === 0) return { kind: 'global' };
  if (kind === 'league' && rest.length === 1) return { kind: 'league', leagueId: rest[0] as string };
  if (kind === 'team' && rest.length === 3) {
    const [leagueId, teamId, tenureKey] = rest as [string, string, string];
    return { kind: 'team', leagueId, teamId, tenureKey };
  }
  return null;
}

export interface SubscribeRepos {
  leagues: Pick<LeagueRepository, 'get'>;
  teams: Pick<TeamRepository, 'get' | 'list'>;
}

/** Null when `sub` may subscribe to `channel`, otherwise why not. */
export async function authorizeSubscribe(
  repos: SubscribeRepos,
  sub: string,
  channel: string
): Promise<string | null> {
  const ref = parseChannel(channel);
  if (ref === null) return 'Unknown channel.';
  if (ref.kind === 'global') return null;
  if (ref.kind === 'league') {
    const league = await repos.leagues.get(ref.leagueId);
    if (league === null) return 'You are not a member of this league.';
    const principal: UserPrincipal = { type: 'user', sub, email: null, name: '' };
    const actor = resolveActor(league, await repos.teams.list(ref.leagueId), principal);
    return isOutsider(actor) ? 'You are not a member of this league.' : null;
  }
  const team = await repos.teams.get(ref.leagueId, ref.teamId);
  if (team === null || team.ownerUserId !== sub) return 'You do not hold this seat.';
  // The seat changed hands since the channel was handed out (or the key is made up).
  if (seatTenureKey(team) !== ref.tenureKey) return 'This channel is for an earlier seat tenure.';
  return null;
}

/** The parts of AppSync Events' Lambda request this handler reads. */
export interface SubscribeRequest {
  identity?: { sub?: unknown } | null;
  info?: { operation?: unknown; channel?: { path?: unknown } | null } | null;
}

/** AppSync allows the subscribe when the handler returns nothing, and refuses it with `error`. */
export type SubscribeResponse = { error: string } | null;

export function createSubscribeHandler(repos: SubscribeRepos, log: Logger) {
  return async (request: SubscribeRequest): Promise<SubscribeResponse> => {
    const sub = request.identity?.sub;
    const channel = request.info?.channel?.path;
    if (request.info?.operation !== 'SUBSCRIBE' || typeof channel !== 'string') {
      return { error: 'Only subscribes are handled here.' };
    }
    if (typeof sub !== 'string' || sub.length === 0) return { error: 'Sign in to subscribe.' };
    const refusal = await authorizeSubscribe(repos, sub, channel);
    if (refusal === null) return null;
    log.info('realtime subscribe refused', { channel, sub, reason: refusal });
    return { error: refusal };
  };
}
