import {
  nextWaiverRun,
  resolveWaivers,
  waiverRunAtOrAfter,
  waiverRunId,
  type WaiverClaim,
  type WaiverTeamState
} from '@fantasy/core';
import { ApiError } from '../errors.js';
import type { WaiverAward } from '../events/details.js';
import type { EventPublisher } from '../events/publisher.js';
import { toPlayerRef } from '../players/model.js';
import type { Logger } from '../log.js';
import type { League, Repos, Team } from '../repos/types.js';
import type { TransactionRecord, WaiverClaimRecord } from '../repos/waivers.js';
import { acquisitionsThisWeek, changeRoster, leaguePlayers, rosterEntries } from './rosters.js';

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
 * - Afterwards the teams' waiver priorities follow core's new order, `Waivers Processed` is emitted,
 *   and the next window opens (`Waiver Window Opened`, `deadlines.nextWaiverRunAt`).
 */

export interface ProcessDeps {
  repos: Repos;
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
  const players = await leaguePlayers(repos, league.id, teams, now);
  const pending = await repos.waivers.listClaims(league.id, 'pending');
  const due = pending.filter((c) => {
    const s = players.standing(c.addPlayerId);
    return s.status !== 'waivers';
  });

  // Recover awards an interrupted run already applied to the team.
  const recovered: WaiverClaimRecord[] = [];
  const toResolve: WaiverClaimRecord[] = [];
  for (const claim of due) {
    if (claim.awardingRunId !== null && players.ownerOf.get(claim.addPlayerId) === claim.teamId)
      recovered.push(claim);
    else toResolve.push(claim);
  }
  const transactions: TransactionRecord[] = [];
  for (const claim of recovered) {
    await markAwarded(repos, claim, now);
    transactions.push(txn(league.id, claim, at, week, claim.bid));
  }

  const acquisitions = await acquisitionsThisWeek(repos, league, now);
  const state: Record<string, WaiverTeamState> = {};
  for (const team of teams) {
    state[team.id] = {
      roster: rosterEntries(team),
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
    )
  });

  const byId = new Map(toResolve.map((c) => [c.id, c]));
  let awarded = recovered.length;
  let failed = 0;
  for (const award of resolution.awarded) {
    const claim = await repos.waivers.updateClaim({
      ...(byId.get(award.claim.claimId) as WaiverClaimRecord),
      awardingRunId: runId
    });
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
      failed += 1;
      await markFailed(repos, claim, now, { code: error.code, message: error.message, fix: error.fix });
      continue;
    }
    await markAwarded(repos, claim, now, award.cost);
    transactions.push(txn(league.id, claim, at, week, award.cost));
    awarded += 1;
  }
  for (const f of resolution.failed) {
    const claim = byId.get(f.claim.claimId) as WaiverClaimRecord;
    failed += 1;
    await markFailed(repos, claim, now, { code: f.issue.code, message: f.issue.message, fix: f.issue.fix });
  }
  await repos.waivers.addTransactions(transactions);
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
    (await repos.players.getMany([...new Set(ids.filter((pid): pid is string => pid !== null))])).map(
      (p) => [p.id, toPlayerRef(p)]
    )
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

async function markAwarded(
  repos: Repos,
  claim: WaiverClaimRecord,
  now: Date,
  cost = claim.bid
): Promise<void> {
  await repos.waivers.updateClaim({
    ...claim,
    status: 'awarded',
    resolvedAt: now.toISOString(),
    cost,
    failure: null
  });
}

async function markFailed(
  repos: Repos,
  claim: WaiverClaimRecord,
  now: Date,
  failure: { code: string; message: string; fix: string }
): Promise<void> {
  await repos.waivers.updateClaim({ ...claim, status: 'failed', resolvedAt: now.toISOString(), failure });
}

/** Writes each team's new place on the priority list (1 = first), re-reading on a conflict. */
async function applyPriorities(
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
