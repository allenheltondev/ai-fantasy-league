import type { LineupEntry } from '../scoring/engine.js';
import { ruleError, ruleWarning, type RuleIssue } from './issues.js';
import {
  ROSTER_SLOTS,
  WILL_NOT_PLAY_STATUSES,
  eligibleStarterSlots,
  isEligibleForSlot,
  isStarterSlot,
  type PlayerStatus,
  type Position,
  type RosterSlot
} from './positions.js';
import { activeRosterSize, slotCount, type LeagueSettings } from './settings.js';

export type { LineupEntry } from '../scoring/engine.js';

/** What the rules need to know about a rostered player. */
export interface RosterPlayer {
  playerId: string;
  /** Display name, used in messages when present. */
  name?: string;
  /** Fantasy positions the player is eligible at (Sleeper `fantasy_positions`, normalized). */
  positions: readonly Position[];
  status: PlayerStatus;
  /** NFL team abbreviation (for DEF, the team itself); null for free agents. */
  nflTeam: string | null;
}

export type Instant = string | Date;

/** This week's NFL games keyed by team abbreviation. A team with no entry is on bye. */
export type WeekGames = Readonly<Record<string, { kickoff: Instant }>>;

export interface LineupContext {
  /** When present, starters on bye (or without a team) produce warnings. */
  games?: WeekGames;
  /** The current time, supplied by the caller's clock. Needed for lock checks. */
  now?: Instant;
  /**
   * The lineup currently saved. With `games` and `now`, any player whose game has kicked off must
   * keep the slot he has here (players missing from it count as BN).
   */
  previousLineup?: readonly LineupEntry[];
}

export interface LineupValidation {
  valid: boolean;
  errors: RuleIssue[];
  warnings: RuleIssue[];
  /** The full lineup with every rostered player; players left out of the input are placed on BN. */
  lineup: LineupEntry[];
}

function toMs(t: Instant): number {
  return typeof t === 'string' ? new Date(t).getTime() : t.getTime();
}

/** Kickoff of the player's game this week, or null if he has no game (bye or no team). */
export function playerKickoff(player: Pick<RosterPlayer, 'nflTeam'>, games: WeekGames): Date | null {
  if (!player.nflTeam) return null;
  const game = games[player.nflTeam];
  return game ? new Date(toMs(game.kickoff)) : null;
}

/** True once the player's game has kicked off. Players without a game this week never lock. */
export function isPlayerLocked(
  player: Pick<RosterPlayer, 'nflTeam'>,
  games: WeekGames,
  now: Instant
): boolean {
  const kickoff = playerKickoff(player, games);
  return kickoff !== null && kickoff.getTime() <= toMs(now);
}

/** True when the player's team has no game in `games` (bye week or no team). */
export function isOnBye(player: Pick<RosterPlayer, 'nflTeam'>, games: WeekGames): boolean {
  return playerKickoff(player, games) === null;
}

function label(player: RosterPlayer | undefined, playerId: string): string {
  return player?.name ? `${player.name} (${playerId})` : playerId;
}

/** Number of players occupying active (non-IR) roster spots. */
export function activePlayerCount(lineup: readonly LineupEntry[]): number {
  return lineup.filter((e) => e.slot !== 'IR').length;
}

/** Open active roster spots; negative when the roster is over the limit. */
export function openRosterSpots(
  settings: Pick<LeagueSettings, 'roster'>,
  lineup: readonly LineupEntry[]
): number {
  return activeRosterSize(settings) - activePlayerCount(lineup);
}

/**
 * Validates a lineup against league settings and a team's roster.
 *
 * Errors: unknown or duplicate players, slots the league does not have or that are overfilled,
 * position ineligibility, IR status ineligibility, too many active players, and moving a locked player.
 * Warnings (still allowed): starters on bye, starters ruled out, empty starting slots.
 */
export function validateLineup(
  settings: Pick<LeagueSettings, 'roster'>,
  roster: readonly RosterPlayer[],
  lineup: readonly LineupEntry[],
  context: LineupContext = {}
): LineupValidation {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const byId = new Map(roster.map((p) => [p.playerId, p]));
  const seen = new Set<string>();
  const normalized: LineupEntry[] = [];

  for (const entry of lineup) {
    const player = byId.get(entry.playerId);
    if (!player) {
      errors.push(
        ruleError(
          'PLAYER_NOT_ON_ROSTER',
          `lineup.${entry.playerId}`,
          `Player ${entry.playerId} is not on this roster.`,
          'Remove that player from the lineup; only rostered players can be slotted.'
        )
      );
      continue;
    }
    if (seen.has(entry.playerId)) {
      errors.push(
        ruleError(
          'DUPLICATE_PLAYER',
          `lineup.${entry.playerId}`,
          `${label(player, entry.playerId)} appears in the lineup more than once.`,
          'List each player once, in a single slot.'
        )
      );
      continue;
    }
    seen.add(entry.playerId);
    normalized.push({ playerId: entry.playerId, slot: entry.slot });

    if (entry.slot === 'IR') {
      const allowed = (settings.roster.irEligibleStatuses as readonly PlayerStatus[]).includes(player.status);
      if (!allowed) {
        errors.push(
          ruleError(
            'IR_INELIGIBLE',
            `lineup.${entry.playerId}`,
            `${label(player, entry.playerId)} has status "${player.status}" and cannot be on IR (allowed: ${settings.roster.irEligibleStatuses.join(', ')}).`,
            'Move this player to BN or a starting slot; drop someone first if the roster is full.',
            { status: player.status }
          )
        );
      }
    } else if (!isEligibleForSlot(entry.slot, player.positions)) {
      const options = eligibleStarterSlots(player.positions).filter((s) => slotCount(settings, s) > 0);
      errors.push(
        ruleError(
          'INELIGIBLE_FOR_SLOT',
          `lineup.${entry.playerId}`,
          `${label(player, entry.playerId)} (${player.positions.join('/')}) cannot play ${entry.slot}.`,
          `Put this player in ${[...options, 'BN'].join(', ')}.`,
          { slot: entry.slot, positions: player.positions }
        )
      );
    }
  }

  for (const player of roster) {
    if (!seen.has(player.playerId)) normalized.push({ playerId: player.playerId, slot: 'BN' });
  }

  const counts = new Map<RosterSlot, number>();
  for (const e of normalized) counts.set(e.slot, (counts.get(e.slot) ?? 0) + 1);

  for (const slot of ROSTER_SLOTS) {
    const used = counts.get(slot) ?? 0;
    const limit = slotCount(settings, slot);
    if (slot === 'BN') continue; // bench overflow is reported as a roster-size problem below
    if (used > limit) {
      errors.push(
        ruleError(
          limit === 0 ? 'SLOT_NOT_IN_LEAGUE' : 'SLOT_OVERFILLED',
          `lineup.slots.${slot}`,
          limit === 0
            ? `This league has no ${slot} slot.`
            : `${used} players are in ${slot}, but the league allows ${limit}.`,
          `Move ${used - limit} player(s) out of ${slot} (to BN or another eligible slot).`
        )
      );
    } else if (isStarterSlot(slot) && used < limit) {
      warnings.push(
        ruleWarning(
          'EMPTY_STARTER_SLOT',
          `lineup.slots.${slot}`,
          `${limit - used} ${slot} slot(s) are empty and will score 0.`,
          `Move an eligible bench player into ${slot}, or add one from free agency.`
        )
      );
    }
  }

  const active = activePlayerCount(normalized);
  const limit = activeRosterSize(settings);
  if (active > limit) {
    errors.push(
      ruleError(
        'ROSTER_FULL',
        'lineup',
        `${active} players occupy active roster spots, but the limit is ${limit}.`,
        `Drop ${active - limit} player(s), or move an IR-eligible player to an open IR slot.`,
        { active, limit }
      )
    );
  }

  const { games, now, previousLineup } = context;
  for (const e of normalized) {
    const player = byId.get(e.playerId);
    if (!player || !isStarterSlot(e.slot)) continue;
    if (games && isOnBye(player, games)) {
      warnings.push(
        ruleWarning(
          player.nflTeam ? 'STARTER_ON_BYE' : 'STARTER_HAS_NO_TEAM',
          `lineup.${e.playerId}`,
          player.nflTeam
            ? `${label(player, e.playerId)} is starting at ${e.slot}, but ${player.nflTeam} does not play this week.`
            : `${label(player, e.playerId)} is starting at ${e.slot} but is not on an NFL team.`,
          'Bench this player and start someone with a game this week.'
        )
      );
    }
    if (WILL_NOT_PLAY_STATUSES.includes(player.status)) {
      warnings.push(
        ruleWarning(
          'STARTER_NOT_PLAYING',
          `lineup.${e.playerId}`,
          `${label(player, e.playerId)} is starting at ${e.slot} with status "${player.status}".`,
          'Bench this player and start a healthy one.'
        )
      );
    }
  }

  if (games && now !== undefined && previousLineup) {
    const before = new Map(previousLineup.map((e) => [e.playerId, e.slot]));
    for (const e of normalized) {
      const player = byId.get(e.playerId);
      const prevSlot = before.get(e.playerId) ?? 'BN';
      if (player && prevSlot !== e.slot && isPlayerLocked(player, games, now)) {
        errors.push(
          ruleError(
            'PLAYER_LOCKED',
            `lineup.${e.playerId}`,
            `${label(player, e.playerId)}'s game has kicked off, so he must stay in ${prevSlot}.`,
            `Keep ${label(player, e.playerId)} in ${prevSlot}, and leave any slot he occupies alone.`,
            { from: prevSlot, to: e.slot }
          )
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, lineup: normalized };
}
