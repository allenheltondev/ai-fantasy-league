import {
  DAY_MS,
  openRosterSpots,
  waiverClearsAt,
  waiverRunAtOrAfter,
  type LineupEntry,
  type LeagueSettings
} from '@fantasy/core';
import { ApiError } from '../errors.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { WaiverWireEntry } from '../repos/waivers.js';
import type { WeekLocks } from '../season/lineups.js';

/**
 * Roster changes for adds, drops, and waiver awards, and where every player stands in a league.
 *
 * A player can join a roster only after his `OWN#` lock is taken for that team, so two adds of the
 * same player can never both land. Team writes are version-checked and retried against the latest
 * team, so a roster change never overwrites another one.
 *
 * The roster limit counts the week's lineup (`resolveLineup` in season/lineups.ts): players in IR
 * slots do not take an active spot. A drop needs no lineup write: lineups are reconciled with the
 * roster whenever they are read, so a dropped player leaves his slot and an added one starts on the
 * bench.
 */

/** Why an unrostered player is on waivers. */
export type WaiverReason = 'dropped' | 'game_time' | 'post_draft';

export type PlayerStanding =
  | { status: 'rostered'; teamId: string }
  | {
      status: 'waivers';
      /** The waiver run that processes claims on him; he is a free agent from then on. */
      clearsAt: string;
      reason: WaiverReason;
      droppedByTeamId: string | null;
    }
  | { status: 'free_agent' };

export interface LeaguePlayers {
  /** Where the player stands. Pass his NFL team to apply game-time waivers (needs `locks`). */
  standing(playerId: string, nflTeam?: string | null): PlayerStanding;
  /** The team rostering each player. */
  ownerOf: ReadonlyMap<string, string>;
  wire: ReadonlyMap<string, WaiverWireEntry>;
}

/**
 * Where every player stands in the league at `now`: on a roster, on waivers, or a free agent.
 *
 * An unrostered player is on waivers until the latest of these that applies:
 * - `dropped`: his waiver period after a drop (the wire entry), rounded up to the waiver run;
 * - `post_draft`: `deadlines.postDraftWaiversUntil` (leagues with `postDraftPlayers: waivers`);
 * - `game_time`: once his game this week has kicked off, until the first waiver run after the week
 *   is over (Yahoo's game-time waivers), so nobody picks up a player whose points are known.
 * Every end is a waiver run, so a player never turns free agent before the claims on him run.
 */
export async function leaguePlayers(
  repos: Pick<Repos, 'waivers'>,
  league: Pick<League, 'id' | 'deadlines'>,
  teams: readonly Team[],
  now: Date,
  locks?: WeekLocks
): Promise<LeaguePlayers> {
  const ownerOf = new Map<string, string>();
  for (const team of teams) for (const playerId of team.roster) ownerOf.set(playerId, team.id);
  const wire = new Map((await repos.waivers.listWire(league.id)).map((e) => [e.playerId, e]));
  const postDraft = league.deadlines.postDraftWaiversUntil ?? null;
  const gameTimeUntil = locks?.endsAt == null ? null : waiverRunAtOrAfter(locks.endsAt);
  return {
    ownerOf,
    wire,
    standing(playerId, nflTeam) {
      const teamId = ownerOf.get(playerId);
      if (teamId !== undefined) return { status: 'rostered', teamId };
      const options: Extract<PlayerStanding, { status: 'waivers' }>[] = [];
      const entry = wire.get(playerId);
      if (entry !== undefined) {
        const clearsAt = waiverRunAtOrAfter(entry.clearsAt);
        options.push({
          status: 'waivers',
          clearsAt,
          reason: 'dropped',
          droppedByTeamId: entry.droppedByTeamId
        });
      }
      if (postDraft !== null) {
        options.push({ status: 'waivers', clearsAt: postDraft, reason: 'post_draft', droppedByTeamId: null });
      }
      if (gameTimeUntil !== null && nflTeam != null && locks?.isLocked({ team: nflTeam }) === true) {
        options.push({
          status: 'waivers',
          clearsAt: gameTimeUntil,
          reason: 'game_time',
          droppedByTeamId: null
        });
      }
      const active = options
        .filter((o) => Date.parse(o.clearsAt) > now.getTime())
        .sort((a, b) => Date.parse(b.clearsAt) - Date.parse(a.clearsAt));
      return active[0] ?? { status: 'free_agent' };
    }
  };
}

/** Open active roster spots in a lineup, counting a drop outside IR as freeing one. */
export function openSpots(
  settings: LeagueSettings,
  lineup: readonly LineupEntry[],
  dropPlayerId: string | null
): number {
  const dropFrees = lineup.some((e) => e.playerId === dropPlayerId && e.slot !== 'IR') ? 1 : 0;
  return openRosterSpots(settings, lineup) + dropFrees;
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

/**
 * When a player dropped at `droppedAt` clears waivers: the waiver period (core `waiverClearsAt`)
 * rounded up to the waiver run that processes the claims on him. Null with a 0-day waiver period.
 */
export function dropClearsAt(settings: Pick<LeagueSettings, 'waivers'>, droppedAt: Date): string | null {
  if (settings.waivers.waiverPeriodDays === 0) return null;
  return waiverRunAtOrAfter(waiverClearsAt(settings, { droppedAt }));
}

/**
 * Puts a dropped player on the league's waiver wire for the waiver period (`dropClearsAt`) and
 * returns when he clears (`droppedAt` itself when the league has no waiver period).
 */
export async function putOnWaivers(
  repos: Pick<Repos, 'waivers'>,
  settings: Pick<LeagueSettings, 'waivers'>,
  input: { leagueId: string; playerId: string; teamId: string; droppedAt: Date }
): Promise<string> {
  const clearsAt = dropClearsAt(settings, input.droppedAt);
  if (clearsAt === null) return input.droppedAt.toISOString();
  await repos.waivers.putWireEntry({
    leagueId: input.leagueId,
    playerId: input.playerId,
    droppedByTeamId: input.teamId,
    droppedAt: input.droppedAt.toISOString(),
    clearsAt
  });
  return clearsAt;
}
