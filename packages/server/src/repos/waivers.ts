import { ApiError } from '../errors.js';

/**
 * Waivers and free agency persistence (#55): claims, the league's waiver wire (players dropped
 * recently, with when they clear), the transactions log, per-window processing runs, and player
 * ownership locks. Everything lives in the league partition; the keys are in
 * docs/adr/001-table-design.md and `dynamo/waivers.ts`.
 */

export const WAIVER_CLAIM_STATUSES = ['pending', 'awarded', 'failed', 'cancelled'] as const;
export type WaiverClaimStatus = (typeof WAIVER_CLAIM_STATUSES)[number];

export interface WaiverClaimRecord {
  id: string;
  leagueId: string;
  teamId: string;
  addPlayerId: string;
  dropPlayerId: string | null;
  /** Whole dollars; 0 under rolling waivers. */
  bid: number;
  /** The team's own order for its claims: 1 is processed first. */
  priority: number;
  status: WaiverClaimStatus;
  /** NFL week when the claim was made. */
  week: number;
  /** The first waiver run that can process it (when the player clears waivers). */
  processesAt: string;
  createdAt: string;
  /** Principal key of whoever made it (`user#<sub>` or `agent#<agentId>`). */
  createdBy: string;
  resolvedAt: string | null;
  /** Why a failed claim failed (a stable core code such as PLAYER_CLAIMED) and how to do better. */
  failure: { code: string; message: string; fix: string } | null;
  /** FAAB charged when awarded. */
  cost: number | null;
  /**
   * The run applying this claim's award, set just before the roster write. A run that crashed after
   * the roster write but before marking the claim is recovered from it without charging twice.
   */
  awardingRunId: string | null;
  version: number;
}

/** A dropped player on the league's waiver wire until `clearsAt`. */
export interface WaiverWireEntry {
  leagueId: string;
  playerId: string;
  droppedByTeamId: string;
  droppedAt: string;
  clearsAt: string;
}

export const TRANSACTION_TYPES = ['add', 'drop', 'waiver_claim'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface TransactionRecord {
  id: string;
  leagueId: string;
  at: string;
  week: number;
  /** `add`: a free-agent pickup; `drop`: a release; `waiver_claim`: a claim awarded by a waiver run. */
  type: TransactionType;
  teamId: string;
  addPlayerId: string | null;
  dropPlayerId: string | null;
  /** FAAB paid (waiver claims only). */
  cost: number | null;
  claimId: string | null;
}

export interface WaiverRunRecord {
  leagueId: string;
  /** `YYYY-MM-DD`: one processing window per day. */
  runId: string;
  status: 'running' | 'complete';
  startedAt: string;
  completedAt: string | null;
  awarded: number;
  failed: number;
}

export interface TransactionPage {
  items: TransactionRecord[];
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

export interface WaiverRepository {
  /** Creates a claim; CONFLICT if the id exists. */
  createClaim(claim: WaiverClaimRecord): Promise<void>;
  getClaim(leagueId: string, claimId: string): Promise<WaiverClaimRecord | null>;
  /** Every claim in the league (optionally one status), oldest first. */
  listClaims(leagueId: string, status?: WaiverClaimStatus): Promise<WaiverClaimRecord[]>;
  /** Version-checked write; CONFLICT when the claim changed. */
  updateClaim(claim: WaiverClaimRecord): Promise<WaiverClaimRecord>;

  /** Puts (or replaces) a player's waiver-wire entry. */
  putWireEntry(entry: WaiverWireEntry): Promise<void>;
  /** Every player the league has ever put on waivers, with their latest clear time. */
  listWire(leagueId: string): Promise<WaiverWireEntry[]>;

  /** Records transactions; a transaction whose id is already stored is skipped (idempotent). */
  addTransactions(transactions: readonly TransactionRecord[]): Promise<void>;
  /** Newest first. */
  listTransactions(
    leagueId: string,
    query: { limit: number; cursor?: string | null }
  ): Promise<TransactionPage>;
  /** Every transaction at or after `since`, oldest first (acquisition limits). */
  listTransactionsSince(leagueId: string, since: string): Promise<TransactionRecord[]>;

  /**
   * Starts a processing run. Returns false when the run already exists and is complete, or is
   * running and was started after `staleBefore` (another worker has it).
   */
  beginRun(run: WaiverRunRecord, staleBefore: string): Promise<boolean>;
  completeRun(run: WaiverRunRecord): Promise<void>;
  getRun(leagueId: string, runId: string): Promise<WaiverRunRecord | null>;

  /**
   * Takes the ownership lock on a player for a team (`OWN#<playerId>`). Succeeds when the lock is
   * free, already this team's, or held by `staleOwner` (a team whose roster no longer has him, for
   * example after a move that did not release the lock). A player can only join the roster of the
   * team that holds his lock, so two adds of one player never both succeed.
   */
  acquirePlayer(leagueId: string, playerId: string, teamId: string, staleOwner?: string): Promise<boolean>;
  /** Frees the lock if this team holds it. */
  releasePlayer(leagueId: string, playerId: string, teamId: string): Promise<void>;
  /** The team holding a player's lock, or null. */
  playerOwner(leagueId: string, playerId: string): Promise<string | null>;
}

export function claimExists(claimId: string): ApiError {
  return new ApiError('CONFLICT', `Waiver claim ${claimId} already exists.`, {
    fix: 'Retry with a new idempotency key; the claim was already created.'
  });
}

export function staleClaim(claimId: string): ApiError {
  return new ApiError('CONFLICT', `Waiver claim ${claimId} changed while this request was running.`, {
    fix: 'Read your claims again (list_waiver_claims) and retry.'
  });
}
