import { DAY_MS, openRosterSpots, type LineupEntry, type LeagueSettings } from '@fantasy/core';
import { ApiError } from '../errors.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { WaiverWireEntry } from '../repos/waivers.js';

/**
 * Roster changes for adds, drops, and waiver awards, and where every player stands in a league.
 *
 * A player can join a roster only after his `OWN#` lock is taken for that team, so two adds of the
 * same player can never both land. Team writes are version-checked and retried against the latest
 * team, so a roster change never overwrites another one.
 *
 * Rosters are plain player ids today; lineup slots arrive with the lineup stream. Until then every
 * rostered player counts toward the active limit (nobody is on IR), and a drop only leaves the
 * roster (there is no lineup slot to clear yet).
 */

export type PlayerStanding =
  | { status: 'rostered'; teamId: string }
  | { status: 'waivers'; clearsAt: string; droppedByTeamId: string }
  | { status: 'free_agent' };

export interface LeaguePlayers {
  standing(playerId: string): PlayerStanding;
  /** The team rostering each player. */
  ownerOf: ReadonlyMap<string, string>;
  wire: ReadonlyMap<string, WaiverWireEntry>;
}

/** Where every player stands in the league at `now`: on a roster, on waivers, or a free agent. */
export async function leaguePlayers(
  repos: Pick<Repos, 'waivers'>,
  leagueId: string,
  teams: readonly Team[],
  now: Date
): Promise<LeaguePlayers> {
  const ownerOf = new Map<string, string>();
  for (const team of teams) for (const playerId of team.roster) ownerOf.set(playerId, team.id);
  const wire = new Map((await repos.waivers.listWire(leagueId)).map((e) => [e.playerId, e]));
  return {
    ownerOf,
    wire,
    standing(playerId) {
      const teamId = ownerOf.get(playerId);
      if (teamId !== undefined) return { status: 'rostered', teamId };
      const entry = wire.get(playerId);
      if (entry !== undefined && new Date(entry.clearsAt).getTime() > now.getTime()) {
        return { status: 'waivers', clearsAt: entry.clearsAt, droppedByTeamId: entry.droppedByTeamId };
      }
      return { status: 'free_agent' };
    }
  };
}

/** A roster as core's waiver and lineup code sees it (every player on the bench for now). */
export function rosterEntries(team: Pick<Team, 'roster'>): LineupEntry[] {
  return team.roster.map((playerId) => ({ playerId, slot: 'BN' }));
}

/** Open active roster spots, counting a drop as freeing one. */
export function openSpots(
  settings: LeagueSettings,
  team: Pick<Team, 'roster'>,
  dropPlayerId: string | null
): number {
  const dropFrees = dropPlayerId !== null && team.roster.includes(dropPlayerId) ? 1 : 0;
  return openRosterSpots(settings, rosterEntries(team)) + dropFrees;
}

/** Adds and waiver awards this team made in `week`, for `waivers.maxAcquisitionsPerWeek`. */
export async function acquisitionsThisWeek(
  repos: Pick<Repos, 'waivers'>,
  league: League,
  now: Date
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (league.week === null) return counts;
  const since = new Date(now.getTime() - 8 * DAY_MS).toISOString();
  for (const t of await repos.waivers.listTransactionsSince(league.id, since)) {
    if (t.week === league.week && t.type !== 'drop') counts.set(t.teamId, (counts.get(t.teamId) ?? 0) + 1);
  }
  return counts;
}

export interface RosterChange {
  add?: string | null;
  drop?: string | null;
  /** FAAB to deduct. */
  cost?: number;
}

const MAX_WRITE_ATTEMPTS = 4;

/**
 * Applies a roster change to a team: takes the added player's ownership lock, writes the team
 * (version-checked, re-reading and retrying when another write got there first), then frees the
 * dropped player's lock. Throws PLAYER_NOT_AVAILABLE when another team holds the added player, and
 * PLAYER_NOT_ON_ROSTER when the dropped player left the roster in the meantime.
 */
export async function changeRoster(
  repos: Pick<Repos, 'teams' | 'waivers'>,
  team: Team,
  change: RosterChange,
  now: Date
): Promise<Team> {
  const add = change.add ?? null;
  const drop = change.drop ?? null;
  if (add !== null && !(await acquire(repos, team, add))) {
    throw new ApiError('PLAYER_NOT_AVAILABLE', `Player ${add} was just added by another team.`, {
      fix: 'Search again for available players (search_players with availability "free_agent") and pick another.',
      details: { playerId: add }
    });
  }
  let current = team;
  for (let attempt = 1; ; attempt++) {
    if (drop !== null && !current.roster.includes(drop)) {
      if (add !== null && !current.roster.includes(add))
        await repos.waivers.releasePlayer(team.leagueId, add, team.id);
      throw new ApiError('PLAYER_NOT_ON_ROSTER', `Player ${drop} is not on ${current.name}'s roster.`, {
        fix: 'Read your roster again and pick a player who is on it.',
        details: { playerId: drop }
      });
    }
    const faabRemaining = current.faabRemaining - (change.cost ?? 0);
    if (faabRemaining < 0) {
      if (add !== null) await repos.waivers.releasePlayer(team.leagueId, add, team.id);
      throw new ApiError(
        'INSUFFICIENT_FAAB',
        `${current.name} has only $${current.faabRemaining} FAAB left.`,
        {
          fix: `Bid $${current.faabRemaining} or less.`,
          details: { faabRemaining: current.faabRemaining }
        }
      );
    }
    const roster = current.roster.filter((id) => id !== drop && id !== add);
    if (add !== null) roster.push(add);
    try {
      const updated = await repos.teams.update({
        ...current,
        roster,
        faabRemaining,
        updatedAt: now.toISOString()
      });
      if (drop !== null) await repos.waivers.releasePlayer(team.leagueId, drop, team.id);
      return updated;
    } catch (error) {
      const latest = await repos.teams.get(team.leagueId, team.id);
      if (
        !(error instanceof ApiError) ||
        error.code !== 'CONFLICT' ||
        latest === null ||
        attempt >= MAX_WRITE_ATTEMPTS
      ) {
        if (add !== null) await repos.waivers.releasePlayer(team.leagueId, add, team.id);
        throw error;
      }
      current = latest;
    }
  }
}

/** Takes a player's lock, reclaiming it from a team whose roster no longer has him. */
async function acquire(
  repos: Pick<Repos, 'teams' | 'waivers'>,
  team: Team,
  playerId: string
): Promise<boolean> {
  if (await repos.waivers.acquirePlayer(team.leagueId, playerId, team.id)) return true;
  const holder = await repos.waivers.playerOwner(team.leagueId, playerId);
  if (holder === null) return repos.waivers.acquirePlayer(team.leagueId, playerId, team.id);
  const holderTeam = await repos.teams.get(team.leagueId, holder);
  if (holderTeam !== null && holderTeam.roster.includes(playerId)) return false;
  return repos.waivers.acquirePlayer(team.leagueId, playerId, team.id, holder);
}

/** Puts a dropped player on the league's waiver wire until `clearsAt`. */
export async function putOnWaivers(
  repos: Pick<Repos, 'waivers'>,
  input: { leagueId: string; playerId: string; teamId: string; droppedAt: Date; clearsAt: string }
): Promise<void> {
  await repos.waivers.putWireEntry({
    leagueId: input.leagueId,
    playerId: input.playerId,
    droppedByTeamId: input.teamId,
    droppedAt: input.droppedAt.toISOString(),
    clearsAt: input.clearsAt
  });
}
