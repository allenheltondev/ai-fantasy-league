import { isPlayerLocked, type Instant, type RosterPlayer, type WeekGames } from '../rules/lineup.js';
import type { LeagueSettings } from '../rules/settings.js';
import { DAY_MS, instantMs, shiftInstant } from '../time.js';

export interface WaiverPeriodInput {
  /** When the player was dropped (or, after the draft, when waivers open). */
  droppedAt: Instant;
  /** The dropped player, to check whether his game has kicked off. */
  player?: Pick<RosterPlayer, 'nflTeam'>;
  /** This week's games. With `player`, a player whose game has started counts as locked. */
  games?: WeekGames;
  /**
   * When this week's games are over and locks lift (the weekly rollover). A locked player's waiver
   * period starts here instead of at `droppedAt`.
   */
  locksReleaseAt?: Instant;
}

/**
 * When a dropped player clears waivers and becomes a free agent.
 *
 * The waiver period is `waivers.waiverPeriodDays` days from the drop. If the player's game this week
 * had already kicked off when he was dropped (and `locksReleaseAt` is supplied), the period starts
 * when locks lift instead, so nobody can pick up a player whose points this week are already known.
 */
export function waiverClearsAt(settings: Pick<LeagueSettings, 'waivers'>, input: WaiverPeriodInput): string {
  const { droppedAt, player, games, locksReleaseAt } = input;
  let start = instantMs(droppedAt);
  if (player && games && locksReleaseAt !== undefined && isPlayerLocked(player, games, droppedAt)) {
    start = Math.max(start, instantMs(locksReleaseAt));
  }
  return shiftInstant(new Date(start), settings.waivers.waiverPeriodDays * DAY_MS);
}

/** A player's waiver status: `waiverClearsAt` is null (or absent) for a free agent. */
export interface WaiverStatus {
  waiverClearsAt?: Instant | null;
}

/** True while the player is still on waivers at `now` (claims go through waiver processing). */
export function isOnWaivers(player: WaiverStatus, now: Instant): boolean {
  const clears = player.waiverClearsAt;
  return clears !== undefined && clears !== null && instantMs(now) < instantMs(clears);
}
