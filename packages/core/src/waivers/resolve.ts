import { ruleError, type RuleIssue } from '../rules/issues.js';
import { openRosterSpots, type Instant, type LineupEntry } from '../rules/lineup.js';
import type { LeagueSettings } from '../rules/settings.js';
import { instantMs } from '../time.js';

/** One team's request to add a player off waivers, optionally dropping one of its own players. */
export interface WaiverClaim {
  claimId: string;
  teamId: string;
  addPlayerId: string;
  /** Player to release if the claim wins. Required when the roster is full. */
  dropPlayerId?: string | null;
  /** Whole-dollar FAAB bid. Ignored under rolling waivers. */
  bid: number;
  /** The team's own ranking of its claims: 1 is processed first. */
  priority: number;
  createdAt: Instant;
}

export interface WaiverTeamState {
  /** Everyone on the team, with slots (IR players do not count toward the roster limit). */
  roster: readonly LineupEntry[];
  /** FAAB dollars left. Ignored under rolling waivers. */
  faabRemaining: number;
  /** Adds already made this week, for `maxAcquisitionsPerWeek` (default 0). */
  acquisitionsThisWeek?: number;
}

export interface WaiverState {
  teams: Readonly<Record<string, WaiverTeamState>>;
  /** Waiver priority list, first entry picks first. Every team should appear once. */
  priorityOrder: readonly string[];
  /** Players that may be claimed in this run (on waivers or free agents). */
  availablePlayerIds: readonly string[];
  /** Team IDs ordered worst record first. Used by the `reverse_standings` FAAB tiebreak. */
  reverseStandings?: readonly string[];
}

export interface AwardedWaiverClaim {
  claim: WaiverClaim;
  /** 1-based order in which the claim was awarded. */
  sequence: number;
  /** Dollars charged (0 under rolling waivers). */
  cost: number;
}

export interface FailedWaiverClaim {
  claim: WaiverClaim;
  /** Why the claim failed, with a fix written for a person or a model. `issue.code` is stable. */
  issue: RuleIssue;
}

export interface WaiverTransaction {
  sequence: number;
  type: 'waiver_claim';
  claimId: string;
  teamId: string;
  addPlayerId: string;
  dropPlayerId: string | null;
  cost: number;
}

export interface WaiverResolution {
  awarded: AwardedWaiverClaim[];
  failed: FailedWaiverClaim[];
  /** FAAB remaining per team after processing. */
  budgets: Record<string, number>;
  priorityOrder: string[];
  rosters: Record<string, LineupEntry[]>;
  transactions: WaiverTransaction[];
}

interface Working {
  roster: LineupEntry[];
  budget: number;
  acquisitions: number;
}

function sortOwnClaims(a: WaiverClaim, b: WaiverClaim): number {
  return (
    a.priority - b.priority ||
    instantMs(a.createdAt) - instantMs(b.createdAt) ||
    a.claimId.localeCompare(b.claimId)
  );
}

function rank(order: readonly string[], teamId: string): number {
  const i = order.indexOf(teamId);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function fail(
  claim: WaiverClaim,
  code: string,
  message: string,
  fix: string,
  details?: Record<string, unknown>
) {
  return { claim, issue: ruleError(code, `claims.${claim.claimId}`, message, fix, details) };
}

/**
 * Checks a claim at the moment it reaches the front of its team's queue. Returns a failure, or null
 * when the claim may compete for its player.
 */
function checkClaim(
  settings: Pick<LeagueSettings, 'roster' | 'waivers'>,
  claim: WaiverClaim,
  team: Working | undefined,
  available: ReadonlySet<string>,
  awardedTo: ReadonlyMap<string, string>
): FailedWaiverClaim | null {
  const faab = settings.waivers.type === 'faab';
  if (!team) {
    return fail(
      claim,
      'UNKNOWN_TEAM',
      `Team ${claim.teamId} is not in this league.`,
      'Submit claims only for teams in this league.'
    );
  }
  const winner = awardedTo.get(claim.addPlayerId);
  if (winner !== undefined) {
    return fail(
      claim,
      'PLAYER_CLAIMED',
      `Player ${claim.addPlayerId} was awarded to team ${winner} in this run.`,
      faab
        ? 'Bid more next time, or rank this claim higher than claims for less important players.'
        : 'Rank this claim higher next time, or target another player.',
      { winningTeamId: winner }
    );
  }
  if (!available.has(claim.addPlayerId)) {
    return fail(
      claim,
      'PLAYER_UNAVAILABLE',
      `Player ${claim.addPlayerId} is not on waivers or in free agency.`,
      'Claim a player who is not on a roster; use trades for rostered players.'
    );
  }
  if (faab) {
    if (!Number.isInteger(claim.bid) || claim.bid < 0) {
      return fail(
        claim,
        'INVALID_BID',
        `Bid ${claim.bid} is not a whole, non-negative dollar amount.`,
        'Bid a whole number of dollars, 0 or more.'
      );
    }
    if (claim.bid === 0 && !settings.waivers.allowZeroBids) {
      return fail(claim, 'ZERO_BID_NOT_ALLOWED', 'This league does not allow $0 bids.', 'Bid at least $1.');
    }
    if (claim.bid > team.budget) {
      return fail(
        claim,
        'BID_EXCEEDS_BUDGET',
        `Bid $${claim.bid} is more than the $${team.budget} FAAB left.`,
        `Bid $${team.budget} or less.`,
        { bid: claim.bid, remaining: team.budget }
      );
    }
  }
  const max = settings.waivers.maxAcquisitionsPerWeek;
  if (max !== null && team.acquisitions >= max) {
    return fail(
      claim,
      'ACQUISITION_LIMIT_REACHED',
      `Team ${claim.teamId} has used all ${max} adds for this week.`,
      'Wait for next week, when the limit resets.',
      { limit: max }
    );
  }
  const drop = claim.dropPlayerId ?? null;
  if (drop !== null && !team.roster.some((e) => e.playerId === drop)) {
    return fail(
      claim,
      'DROP_PLAYER_NOT_ON_ROSTER',
      `Drop player ${drop} is no longer on the roster (an earlier claim may have dropped him).`,
      'Pick a different drop player, or give each claim its own drop.',
      { dropPlayerId: drop }
    );
  }
  const dropFreesActiveSpot =
    drop !== null && team.roster.some((e) => e.playerId === drop && e.slot !== 'IR');
  if (openRosterSpots(settings, team.roster) + (dropFreesActiveSpot ? 1 : 0) < 1) {
    return fail(
      claim,
      'ROSTER_FULL',
      `Team ${claim.teamId}'s roster is full, so adding ${claim.addPlayerId} needs a drop.`,
      `Set dropPlayerId to one of: ${team.roster
        .filter((e) => e.slot !== 'IR')
        .map((e) => e.playerId)
        .join(', ')}.`
    );
  }
  return null;
}

/**
 * Resolves a batch of waiver claims, the Yahoo way.
 *
 * Processing runs in rounds. In each round every team's front claim (its best-ranked claim still
 * pending) is checked; claims that can no longer succeed fail with a reason and the team's next
 * claim moves up. Among the valid front claims one winner is picked:
 * - FAAB: the highest bid; equal bids go to `waivers.faabTiebreak` (waiver priority, reverse
 *   standings, or the earliest claim), then to the earliest claim and the claim ID.
 * - Rolling: the team highest on the priority list.
 *
 * The winner is charged its bid (FAAB), adds the player to BN and releases its drop player. Under
 * rolling waivers or the `waiver_priority` tiebreak the winner then moves to the back of the
 * priority list. Every other claim for that player fails, and the next round begins.
 */
export function resolveWaivers(
  settings: Pick<LeagueSettings, 'roster' | 'waivers'>,
  claims: readonly WaiverClaim[],
  state: WaiverState
): WaiverResolution {
  const faab = settings.waivers.type === 'faab';
  const tiebreak = settings.waivers.faabTiebreak;
  const teams = new Map<string, Working>();
  for (const [teamId, t] of Object.entries(state.teams)) {
    teams.set(teamId, {
      roster: t.roster.map((e) => ({ ...e })),
      budget: t.faabRemaining,
      acquisitions: t.acquisitionsThisWeek ?? 0
    });
  }
  let order = [...state.priorityOrder];
  for (const teamId of teams.keys()) if (!order.includes(teamId)) order.push(teamId);
  const available = new Set(state.availablePlayerIds);
  const awardedTo = new Map<string, string>();

  const queues = new Map<string, WaiverClaim[]>();
  for (const claim of claims) {
    const q = queues.get(claim.teamId) ?? [];
    q.push(claim);
    queues.set(claim.teamId, q);
  }
  for (const q of queues.values()) q.sort(sortOwnClaims);

  const awarded: AwardedWaiverClaim[] = [];
  const failed: FailedWaiverClaim[] = [];
  const transactions: WaiverTransaction[] = [];

  const beats = (a: WaiverClaim, b: WaiverClaim): boolean => {
    if (faab && a.bid !== b.bid) return a.bid > b.bid;
    if (!faab || tiebreak === 'waiver_priority') {
      const d = rank(order, a.teamId) - rank(order, b.teamId);
      if (d !== 0) return d < 0;
    } else if (tiebreak === 'reverse_standings') {
      const standings = state.reverseStandings ?? order;
      const d = rank(standings, a.teamId) - rank(standings, b.teamId);
      if (d !== 0) return d < 0;
    }
    return sortOwnClaims(a, b) < 0;
  };

  for (;;) {
    const fronts: WaiverClaim[] = [];
    for (const [teamId, q] of queues) {
      while (q.length > 0) {
        const head = q[0] as WaiverClaim;
        const problem = checkClaim(settings, head, teams.get(teamId), available, awardedTo);
        if (!problem) break;
        failed.push(problem);
        q.shift();
      }
      if (q.length > 0) fronts.push(q[0] as WaiverClaim);
    }
    if (fronts.length === 0) break;

    let winner = fronts[0] as WaiverClaim;
    for (const c of fronts) if (beats(c, winner)) winner = c;

    const team = teams.get(winner.teamId) as Working;
    const cost = faab ? winner.bid : 0;
    const drop = winner.dropPlayerId ?? null;
    team.budget -= cost;
    team.acquisitions += 1;
    team.roster = team.roster.filter((e) => e.playerId !== drop);
    team.roster.push({ playerId: winner.addPlayerId, slot: 'BN' });
    available.delete(winner.addPlayerId);
    awardedTo.set(winner.addPlayerId, winner.teamId);
    (queues.get(winner.teamId) as WaiverClaim[]).shift();

    const sequence = awarded.length + 1;
    awarded.push({ claim: winner, sequence, cost });
    transactions.push({
      sequence,
      type: 'waiver_claim',
      claimId: winner.claimId,
      teamId: winner.teamId,
      addPlayerId: winner.addPlayerId,
      dropPlayerId: drop,
      cost
    });
    if (!faab || tiebreak === 'waiver_priority') {
      order = [...order.filter((t) => t !== winner.teamId), winner.teamId];
    }
  }

  const budgets: Record<string, number> = {};
  const rosters: Record<string, LineupEntry[]> = {};
  for (const [teamId, t] of teams) {
    budgets[teamId] = t.budget;
    rosters[teamId] = t.roster;
  }
  return { awarded, failed, budgets, priorityOrder: order, rosters, transactions };
}
