import {
  nextWaiverRun,
  resolveWaivers,
  reverseStandingsOrder,
  waiverRunAtOrAfter,
  waiverRunId,
  type WaiverClaim,
  type WaiverTeamState
} from '@fantasy/core';
import { ApiError, isApiError } from '../errors.js';
import type { WaiverAward } from '../events/details.js';
import type { EventPublisher } from '../events/publisher.js';
import { toPlayerRef } from '../players/model.js';
import type { Logger } from '../log.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { TransactionRecord, WaiverClaimRecord } from '../repos/waivers.js';
import { resolveWeekLineups, weekLocks } from '../season/lineups.js';
import { inTradeError, playersInProcessingTrades, voidStaleOffers } from '../trades/lifecycle.js';
import { acquisitionsThisWeek, changeRoster, leaguePlayers, putOnWaivers } from './rosters.js';

/**
 * Waiver processing for one league (the `processWaivers` job runs it for every in-season league).
 *
 * - One run per window: the window is the UTC day (`waiverRunId`). A run record makes the job
 *   idempotent: a second invocation the same day does nothing, and a run that crashed part-way is
 *   picked up again once it is stale.
 * - Only claims whose player has cleared waivers are due. They go through core's `resolveWaivers`
 *   (highest FAAB bid, ties by waiver priority, each team's own claim order; docs/rules.md).
 * - Each award takes the player's ownership lock, writes the team (roster and FAAB, version-checked),
 *   then marks the claim awarded and records a `waiver_claim` transaction whose id is the claim id.
 *   The claim is stamped with the run (`awardingRunId`) just before the roster write, so a claim
 *   still pending with a stamp and its player already on its team was applied by an interrupted
 *   run: it is only marked, never charged twice.
 * - A claim whose drop player is locked (his game has kicked off) fails with PLAYER_LOCKED before
 *   resolution. The roster limit counts the week's lineup, so IR players take no active spot. The
 *   player an award drops goes on waivers like any other drop.
 * - `faabTiebreak: reverse_standings` breaks tied bids with the latest standings, worst first.
 * - A claim cancelled or reordered while the run is going is re-read: a cancelled one is skipped,
 *   so a racing cancel never aborts the league's run.
 * - Afterwards the teams' waiver priorities follow core's new order, `Waivers Processed` is emitted,
 *   and the next window opens (`Waiver Window Opened`, `deadlines.nextWaiverRunAt`).
 */

export interface ProcessDeps {
  repos: Repos;
  /** The NFL schedule, for the lock checks on drop players. */
  reference: ReferenceStore;
  events: EventPublisher;
  log: Logger;
}

export interface ProcessResult {
  leagueId: string;
  runId: string;
  status: 'processed' | 'already_processed';
  awarded: number;
  failed: number;
  pending: number;
}

/** A run left `running` this long is assumed to have crashed and may be taken over. */
export const STALE_RUN_MS = 15 * 60 * 1000;

export async function processLeagueWaivers(
  deps: ProcessDeps,
  league: League,
  now: Date
): Promise<ProcessResult> {
  const { repos } = deps;
  const runId = waiverRunId(now);
  const startedAt = now.toISOString();
  const began = await repos.waivers.beginRun(
    { leagueId: league.id, runId, status: 'running', startedAt, completedAt: null, awarded: 0, failed: 0 },
    new Date(now.getTime() - STALE_RUN_MS).toISOString()
  );
  if (!began)
    return { leagueId: league.id, runId, status: 'already_processed', awarded: 0, failed: 0, pending: 0 };

  // Transactions from one run share a time, so a re-run writes the same keys.
  const at = waiverRunAtOrAfter(`${runId}T00:00:00.000Z`);
  const week = league.week ?? league.settings.schedule.startWeek;
  let teams = await repos.teams.list(league.id);
  const locks = await weekLocks(deps.reference, league, now);
  const players = await leaguePlayers(repos, league, teams, now, locks);
  const pending = await repos.waivers.listClaims(league.id, 'pending');
  const records = new Map(
    (
      await repos.players.getMany([
        ...new Set(pending.flatMap((c) => [c.addPlayerId, c.dropPlayerId ?? []].flat()))
      ])
    ).map((p) => [p.id, p])
  );
  const due = pending.filter(
    (c) => players.standing(c.addPlayerId, records.get(c.addPlayerId)?.team).status !== 'waivers'
  );

  // Recover awards an interrupted run already applied to the team.
  const recovered: WaiverClaimRecord[] = [];
  const toResolve: WaiverClaimRecord[] = [];
  const trading = await playersInProcessingTrades(repos, league.id);
  let failed = 0;
  for (const claim of due) {
    const drop = claim.dropPlayerId === null ? undefined : records.get(claim.dropPlayerId);
    const tradeId = claim.dropPlayerId === null ? undefined : trading.get(claim.dropPlayerId);
    if (claim.awardingRunId !== null && players.ownerOf.get(claim.addPlayerId) === claim.teamId) {
      recovered.push(claim);
    } else if (drop !== undefined && locks.isLocked(drop)) {
      // A locked player cannot be dropped, so this claim cannot go through this week.
      if (await markFailed(repos, claim, now, lockedFailure(drop.name))) failed += 1;
    } else if (claim.dropPlayerId !== null && tradeId !== undefined) {
      // The drop player is leaving in a trade that is processing right now.
      const error = inTradeError(claim.dropPlayerId, tradeId);
      if (await markFailed(repos, claim, now, { code: error.code, message: error.message, fix: error.fix }))
        failed += 1;
    } else {
      toResolve.push(claim);
    }
  }
  const transactions: TransactionRecord[] = [];
  for (const claim of recovered) {
    await markAwarded(repos, claim, now);
    transactions.push(txn(league.id, claim, at, week, claim.bid));
  }

  const acquisitions = await acquisitionsThisWeek(repos, league, now);
  const lineups = await resolveWeekLineups(repos, teams, week);
  const state: Record<string, WaiverTeamState> = {};
  for (const team of teams) {
    state[team.id] = {
      roster: lineups.get(team.id)?.entries ?? [],
      faabRemaining: team.faabRemaining,
      acquisitionsThisWeek: acquisitions.get(team.id) ?? 0
    };
  }
  const priorityOrder = [...teams].sort(
    (a, b) => a.waiverPriority - b.waiverPriority || a.id.localeCompare(b.id)
  );
  const resolution = resolveWaivers(league.settings, toResolve.map(toCoreClaim), {
    teams: state,
    priorityOrder: priorityOrder.map((t) => t.id),
    availablePlayerIds: [...new Set(toResolve.map((c) => c.addPlayerId))].filter(
      (id) => !players.ownerOf.has(id)
    ),
    ...(league.settings.waivers.faabTiebreak === 'reverse_standings'
      ? { reverseStandings: await reverseStandings(repos, league.id, teams) }
      : {})
  });

  const byId = new Map(toResolve.map((c) => [c.id, c]));
  let awarded = recovered.length;
  for (const award of resolution.awarded) {
    // A claim cancelled while the run was going is skipped; a reorder is picked up.
    const claim = await updatePending(repos, byId.get(award.claim.claimId) as WaiverClaimRecord, {
      awardingRunId: runId
    });
    if (claim === null) continue;
    const team = teams.find((t) => t.id === claim.teamId) as Team;
    try {
      const updated = await changeRoster(
        repos,
        team,
        { add: claim.addPlayerId, drop: claim.dropPlayerId, cost: award.cost },
        now
      );
      teams = teams.map((t) => (t.id === updated.id ? updated : t));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (await markFailed(repos, claim, now, { code: error.code, message: error.message, fix: error.fix }))
        failed += 1;
      continue;
    }
    if (claim.dropPlayerId !== null) {
      await putOnWaivers(repos, league.settings, {
        leagueId: league.id,
        playerId: claim.dropPlayerId,
        teamId: claim.teamId,
        droppedAt: now
      });
    }
    await markAwarded(repos, claim, now, award.cost);
    transactions.push(txn(league.id, claim, at, week, award.cost));
    awarded += 1;
  }
  for (const f of resolution.failed) {
    const claim = byId.get(f.claim.claimId) as WaiverClaimRecord;
    if (
      await markFailed(repos, claim, now, { code: f.issue.code, message: f.issue.message, fix: f.issue.fix })
    )
      failed += 1;
  }
  await repos.waivers.addTransactions(transactions);
  // Offers that include a player who just changed rosters no longer work.
  await voidStaleOffers(
    deps,
    league,
    transactions.flatMap((t) => [t.addPlayerId, t.dropPlayerId]),
    now
  );
  await applyPriorities(repos, league.id, resolution.priorityOrder, now);

  const closesAt = nextWaiverRun(now);
  await openNextWindow(repos, league.id, closesAt, now);
  await repos.waivers.completeRun({
    leagueId: league.id,
    runId,
    status: 'complete',
    startedAt,
    completedAt: now.toISOString(),
    awarded,
    failed
  });
  const stillPending = pending.length - due.length;
  await deps.events.publish('Waivers Processed', {
    leagueId: league.id,
    runId,
    week,
    awarded: await waiverAwards(repos, transactions, due),
    failed,
    pending: stillPending
  });
  await deps.events.publish('Waiver Window Opened', {
    leagueId: league.id,
    week,
    opensAt: startedAt,
    closesAt
  });
  deps.log.info('waivers processed', { leagueId: league.id, runId, awarded, failed, pending: stillPending });
  return { leagueId: league.id, runId, status: 'processed', awarded, failed, pending: stillPending };
}

/**
 * The awards as `Waivers Processed` carries them: player refs (so the chat announcement can name
 * them), the bid, and the FAAB paid.
 */
async function waiverAwards(
  repos: Pick<Repos, 'players'>,
  transactions: readonly TransactionRecord[],
  claims: readonly WaiverClaimRecord[]
): Promise<WaiverAward[]> {
  const ids = transactions.flatMap((t) => [t.addPlayerId, t.dropPlayerId]);
  const players = new Map(
    (await repos.players.getMany([...new Set(ids.filter((pid): pid is string => pid !== null))])).map((p) => [
      p.id,
      toPlayerRef(p)
    ])
  );
  const bids = new Map(claims.map((c) => [c.id, c.bid]));
  return transactions.map((t) => {
    const playerId = t.addPlayerId as string;
    return {
      teamId: t.teamId,
      playerId,
      player: players.get(playerId) ?? null,
      dropPlayerId: t.dropPlayerId,
      dropPlayer: t.dropPlayerId === null ? null : (players.get(t.dropPlayerId) ?? null),
      bid: bids.get(t.claimId as string) as number,
      cost: t.cost as number
    };
  });
}

function toCoreClaim(c: WaiverClaimRecord): WaiverClaim {
  return {
    claimId: c.id,
    teamId: c.teamId,
    addPlayerId: c.addPlayerId,
    dropPlayerId: c.dropPlayerId,
    bid: c.bid,
    priority: c.priority,
    createdAt: c.createdAt
  };
}

function txn(
  leagueId: string,
  claim: WaiverClaimRecord,
  at: string,
  week: number,
  cost: number
): TransactionRecord {
  return {
    id: claim.id,
    leagueId,
    at,
    week,
    type: 'waiver_claim',
    teamId: claim.teamId,
    addPlayerId: claim.addPlayerId,
    dropPlayerId: claim.dropPlayerId,
    cost,
    claimId: claim.id
  };
}

const MAX_CLAIM_WRITES = 4;

/**
 * Writes a change to a claim that must still be pending. On a version conflict (the team cancelled
 * or reordered while the run was going) it re-reads the claim: a claim no longer pending is left
 * alone (null), a reordered one gets the change on top. `force` writes even when it is no longer
 * pending, for an award whose roster change already happened.
 */
async function updatePending(
  repos: Repos,
  claim: WaiverClaimRecord,
  patch: Partial<WaiverClaimRecord>,
  force = false
): Promise<WaiverClaimRecord | null> {
  let current = claim;
  for (let attempt = 1; ; attempt++) {
    try {
      return await repos.waivers.updateClaim({ ...current, ...patch });
    } catch (error) {
      if (!isApiError(error) || error.code !== 'CONFLICT' || attempt >= MAX_CLAIM_WRITES) throw error;
      const latest = await repos.waivers.getClaim(claim.leagueId, claim.id);
      if (latest === null || (latest.status !== 'pending' && !force)) return null;
      current = latest;
    }
  }
}

async function markAwarded(
  repos: Repos,
  claim: WaiverClaimRecord,
  now: Date,
  cost = claim.bid
): Promise<void> {
  await updatePending(
    repos,
    claim,
    { status: 'awarded', resolvedAt: now.toISOString(), cost, failure: null },
    true
  );
}

/** Marks a claim failed; false when it was cancelled in the meantime and left alone. */
async function markFailed(
  repos: Repos,
  claim: WaiverClaimRecord,
  now: Date,
  failure: { code: string; message: string; fix: string }
): Promise<boolean> {
  return (
    (await updatePending(repos, claim, { status: 'failed', resolvedAt: now.toISOString(), failure })) !== null
  );
}

function lockedFailure(name: string) {
  return {
    code: 'PLAYER_LOCKED',
    message: `The drop player ${name} is locked: his game this week has kicked off, so he cannot be dropped.`,
    fix: 'Claim again with a drop player whose game has not started, or after the week rolls over.'
  };
}

/** Team ids worst record first, from the latest standings (the `reverse_standings` tiebreak). */
async function reverseStandings(repos: Repos, leagueId: string, teams: readonly Team[]): Promise<string[]> {
  const standings = await repos.schedule.latestStandings(leagueId);
  const byPriority = [...teams].sort((a, b) => a.waiverPriority - b.waiverPriority).map((t) => t.id);
  return reverseStandingsOrder(standings?.rows ?? [], byPriority);
}

/** Writes each team's new place on the priority list (1 = first), re-reading on a conflict. */
export async function applyPriorities(
  repos: Repos,
  leagueId: string,
  order: readonly string[],
  now: Date
): Promise<void> {
  for (const [index, teamId] of order.entries()) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const team = await repos.teams.get(leagueId, teamId);
      if (team === null || team.waiverPriority === index + 1) break;
      try {
        await repos.teams.update({ ...team, waiverPriority: index + 1, updatedAt: now.toISOString() });
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'CONFLICT') throw error;
      }
    }
  }
}

/** Records when the next window closes on the league, retrying on a concurrent league write. */
async function openNextWindow(repos: Repos, leagueId: string, closesAt: string, now: Date): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const league = await repos.leagues.get(leagueId);
    if (league === null || league.deadlines.nextWaiverRunAt === closesAt) return;
    try {
      await repos.leagues.update({
        ...league,
        deadlines: { ...league.deadlines, nextWaiverRunAt: closesAt },
        updatedAt: now.toISOString()
      });
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CONFLICT') throw error;
    }
  }
}
