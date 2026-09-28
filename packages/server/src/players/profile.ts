import type { Player as SourcePlayer } from '@fantasy/data';
import { NFL_TEAMS, POSITIONS, type Player, type PlayerStatus, type Position } from './model.js';
import { teamName } from './teams.js';

const POSITION_SET = new Set<string>(POSITIONS);
const TEAM_SET = new Set<string>(NFL_TEAMS);

/** Sleeper's roster status → ours. Anything not active or on IR is inactive for fantasy. */
export function toPlayerStatus(status: string | null): PlayerStatus {
  const s = status?.toLowerCase() ?? '';
  if (s === 'active') return 'active';
  if (s === 'injured reserve') return 'injured_reserve';
  return 'inactive';
}

export function isFantasyPosition(position: string | null): position is Position {
  return position !== null && POSITION_SET.has(position);
}

/**
 * Maps a normalized Sleeper player to the stored profile, or null when the player is outside the
 * fantasy universe (IDP positions, no position). `updatedAt` is when the source last changed.
 */
export function toProfile(source: SourcePlayer, updatedAt: string): Player | null {
  if (!isFantasyPosition(source.position)) return null;
  const team = source.team !== null && TEAM_SET.has(source.team) ? source.team : null;
  return {
    id: source.id,
    name: source.name,
    firstName: source.firstName,
    lastName: source.lastName,
    team,
    position: source.position,
    // Sleeper leaves a team defense's status empty; one on an NFL team is always active.
    status: source.position === 'DEF' && team !== null ? 'active' : toPlayerStatus(source.status),
    injuryStatus: source.injuryStatusRaw ?? source.injuryStatus,
    aliases: source.position === 'DEF' ? defenseAliases(source) : [],
    rank: source.searchRank ?? null,
    updatedAt
  };
}

function defenseAliases(source: SourcePlayer): string[] {
  const code = source.team ?? source.id;
  const aliases = [code, source.lastName, `${source.firstName} D/ST`, ...(teamName(code)?.aliases ?? [])];
  return [...new Set(aliases.filter((a) => a.trim().length > 0))];
}

/**
 * Whether a Sleeper record belongs in the synced universe: a fantasy position, and either on a
 * team, marked active, or already stored (so a released or retired player's change is still seen).
 */
export function inSyncScope(source: SourcePlayer, stored: ReadonlySet<string>): boolean {
  return (
    isFantasyPosition(source.position) && (source.team !== null || source.active || stored.has(source.id))
  );
}
