import { ruleError, ruleWarning, type RuleIssue } from '../rules/issues.js';
import {
  isPlayerLocked,
  type Instant,
  type LineupEntry,
  type RosterPlayer,
  type WeekGames
} from '../rules/lineup.js';
import { activeRosterSize, type LeagueSettings } from '../rules/settings.js';
import { HOUR_MS, instantMs, shiftInstant } from '../time.js';

export const TRADE_STATUSES = [
  'proposed',
  'countered',
  'accepted',
  'rejected',
  'expired',
  'withdrawn',
  'in_review',
  'processed',
  'vetoed'
] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** One team's half of a trade. */
export interface TradeSide {
  teamId: string;
  /** Players this team sends to the other team. */
  sends: readonly string[];
  /** Players this team releases so its roster fits after the trade. */
  drops: readonly string[];
}

export interface TradeEvent {
  status: TradeStatus;
  at: string;
  /** The team that caused the change; null for system changes such as expiry. */
  byTeamId: string | null;
}

/** A structured two-team trade offer. Chat never executes anything; only these objects do. */
export interface Trade {
  tradeId: string;
  /** `sides[0]` is the proposing team, `sides[1]` the team that must respond. */
  sides: readonly [TradeSide, TradeSide];
  status: TradeStatus;
  proposedAt: string;
  expiresAt: string;
  /** The offer this one counters, or null for an opening offer. */
  counterOf: string | null;
  /** Every earlier offer in this negotiation, oldest first. */
  counterChain: readonly string[];
  /** Teams that voted to veto (league vote only). */
  vetoVotes: readonly string[];
  /** When review ends; set when review starts. */
  reviewEndsAt: string | null;
  commissionerApproved: boolean;
  /** Why the trade was vetoed when it was voided rather than voted down. */
  voidReason: RuleIssue | null;
  history: readonly TradeEvent[];
}

/** A rostered player: the rules' view of the player plus his current slot. */
export interface RosteredPlayer extends RosterPlayer {
  slot: LineupEntry['slot'];
}

export type TeamRosters = Readonly<Record<string, readonly RosteredPlayer[]>>;

export interface TradeContext {
  /** Current time from the caller's clock. */
  now: Instant;
  /** Current NFL week. */
  currentWeek: number;
  /** This week's games, for lock checks and the deadline week's first kickoff. */
  games?: WeekGames;
  rosters: TeamRosters;
}

export type TradePhase = 'proposal' | 'acceptance' | 'processing';

export interface TradeValidation {
  valid: boolean;
  errors: RuleIssue[];
  warnings: RuleIssue[];
}

/**
 * When an offer expires: `trades.offerExpiryHours` after it is proposed, or at the next lineup lock
 * when `trades.expireAtNextLineupLock` is on and that lock comes first.
 */
export function expiresAt(
  settings: Pick<LeagueSettings, 'trades'>,
  proposedAt: Instant,
  nextLockTime: Instant | null
): string {
  const byHours = instantMs(proposedAt) + settings.trades.offerExpiryHours * HOUR_MS;
  let at = byHours;
  if (settings.trades.expireAtNextLineupLock && nextLockTime !== null) {
    const lock = instantMs(nextLockTime);
    if (lock > instantMs(proposedAt)) at = Math.min(at, lock);
  }
  return shiftInstant(new Date(at), 0);
}

/**
 * True once no more trades may be processed: after the deadline week, or in the deadline week once
 * its first game has kicked off (the earliest kickoff in `games`).
 */
export function isTradeDeadlinePassed(
  settings: Pick<LeagueSettings, 'trades'>,
  currentWeek: number,
  games: WeekGames | undefined,
  now: Instant
): boolean {
  const deadline = settings.trades.deadlineWeek;
  if (currentWeek !== deadline) return currentWeek > deadline;
  const kickoffs = Object.values(games ?? {}).map((g) => instantMs(g.kickoff));
  return kickoffs.length > 0 && Math.min(...kickoffs) <= instantMs(now);
}

function sidePath(i: number): string {
  return `sides.${i}`;
}

/**
 * Validates a trade against the current rosters and time.
 *
 * Errors: unknown or identical teams, nothing moving, a player listed twice, a sent or dropped
 * player not on that team, the trade deadline, locked players (game already kicked off), and a
 * roster over the active limit after the swap. At `proposal` the responding team's roster overflow is
 * a warning instead, since it chooses its drops when it accepts.
 */
export function validateTrade(
  settings: Pick<LeagueSettings, 'roster' | 'trades'>,
  trade: Pick<Trade, 'sides'>,
  ctx: TradeContext,
  phase: TradePhase
): TradeValidation {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const [a, b] = trade.sides;

  if (a.teamId === b.teamId) {
    errors.push(
      ruleError(
        'SAME_TEAM',
        'sides',
        'A team cannot trade with itself.',
        'Pick a different team to trade with.'
      )
    );
    return { valid: false, errors, warnings };
  }
  trade.sides.forEach((side, i) => {
    if (!ctx.rosters[side.teamId]) {
      errors.push(
        ruleError(
          'UNKNOWN_TEAM',
          `${sidePath(i)}.teamId`,
          `Team ${side.teamId} is not in this league.`,
          'Use a team ID from this league.'
        )
      );
    }
  });
  if (errors.length > 0) return { valid: false, errors, warnings };

  if (a.sends.length + b.sends.length === 0) {
    errors.push(
      ruleError(
        'TRADE_EMPTY',
        'sides',
        'Neither team sends a player.',
        'Add at least one player to one side of the trade.'
      )
    );
  }

  const seen = new Set<string>();
  trade.sides.forEach((side, i) => {
    const roster = ctx.rosters[side.teamId] as readonly RosteredPlayer[];
    const byId = new Map(roster.map((p) => [p.playerId, p]));
    for (const [kind, ids] of [
      ['sends', side.sends],
      ['drops', side.drops]
    ] as const) {
      for (const id of ids) {
        const path = `${sidePath(i)}.${kind}.${id}`;
        if (seen.has(id)) {
          errors.push(
            ruleError(
              'DUPLICATE_PLAYER',
              path,
              `Player ${id} appears in the trade more than once.`,
              'List each player once, either as sent or as dropped.'
            )
          );
          continue;
        }
        seen.add(id);
        const player = byId.get(id);
        if (!player) {
          errors.push(
            ruleError(
              'PLAYER_NOT_ON_ROSTER',
              path,
              `Player ${id} is not on team ${side.teamId}'s roster.`,
              kind === 'sends'
                ? 'Remove this player; the offer is out of date. Re-read both rosters and propose again.'
                : `Drop a player who is on team ${side.teamId}'s roster.`
            )
          );
          continue;
        }
        if (ctx.games && isPlayerLocked(player, ctx.games, ctx.now)) {
          errors.push(
            ruleError(
              'PLAYER_LOCKED',
              path,
              `Player ${id}'s game has kicked off this week, so he cannot be ${kind === 'sends' ? 'traded' : 'dropped'} until the week ends.`,
              'Wait until the weekly rollover, or use a player whose game has not started.'
            )
          );
        }
      }
    }
  });

  if (isTradeDeadlinePassed(settings, ctx.currentWeek, ctx.games, ctx.now)) {
    errors.push(
      ruleError(
        'TRADE_DEADLINE_PASSED',
        'trade',
        `The trade deadline (week ${settings.trades.deadlineWeek} kickoff) has passed.`,
        'Trades are closed for the season; improve the roster through waivers instead.',
        { deadlineWeek: settings.trades.deadlineWeek }
      )
    );
  }

  const limit = activeRosterSize(settings);
  trade.sides.forEach((side, i) => {
    const other = trade.sides[1 - i] as TradeSide;
    const roster = ctx.rosters[side.teamId] as readonly RosteredPlayer[];
    const leaving = new Set([...side.sends, ...side.drops]);
    const staying = roster.filter((p) => !leaving.has(p.playerId));
    const activeAfter = staying.filter((p) => p.slot !== 'IR').length + other.sends.length;
    if (activeAfter <= limit) return;
    const excess = activeAfter - limit;
    const candidates = staying.filter((p) => p.slot !== 'IR').map((p) => p.playerId);
    const message = `After the trade team ${side.teamId} would have ${activeAfter} active players; the limit is ${limit}.`;
    const fix = `Add ${excess} more drop(s) for team ${side.teamId} from: ${candidates.join(', ')}.`;
    const details = { teamId: side.teamId, activeAfter, limit, dropsNeeded: excess };
    if (phase === 'proposal' && i === 1) {
      warnings.push(ruleWarning('RESPONDER_MUST_DROP', `${sidePath(i)}.drops`, message, fix, details));
    } else {
      errors.push(ruleError('ROSTER_LIMIT_EXCEEDED', `${sidePath(i)}.drops`, message, fix, details));
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

export interface ApplyTradeResult<T extends LineupEntry> {
  rosters: Record<string, T[]>;
  /** Players released by the required drops. */
  dropped: T[];
}

/**
 * Swaps the players and releases the required drops. Received players land on BN. Players who are
 * not on the listed team are ignored (validate first), so no player is ever created or lost: every
 * player ends up on exactly one roster or in `dropped`.
 */
export function applyTrade<T extends LineupEntry>(
  rosters: Readonly<Record<string, readonly T[]>>,
  trade: Pick<Trade, 'sides'>
): ApplyTradeResult<T> {
  const out: Record<string, T[]> = {};
  for (const [teamId, players] of Object.entries(rosters)) out[teamId] = [...players];
  const dropped: T[] = [];
  const moving: { player: T; to: string }[] = [];
  const [a, b] = trade.sides;
  if (a.teamId === b.teamId) return { rosters: out, dropped };

  trade.sides.forEach((side, i) => {
    const roster = out[side.teamId];
    if (!roster) return;
    const receiver = (trade.sides[1 - i] as TradeSide).teamId;
    const sends = new Set(side.sends);
    const drops = new Set(side.drops);
    const keep: T[] = [];
    for (const p of roster) {
      if (sends.has(p.playerId) && out[receiver]) moving.push({ player: p, to: receiver });
      else if (drops.has(p.playerId)) dropped.push(p);
      else keep.push(p);
    }
    out[side.teamId] = keep;
  });
  for (const { player, to } of moving) (out[to] as T[]).push({ ...player, slot: 'BN' });
  return { rosters: out, dropped };
}
