import type { Player, Position } from '../players/model.js';

/**
 * Repository interfaces. Each has a DynamoDB implementation (single table, see
 * docs/adr/001-table-design.md) and an in-memory one for unit tests and local runs.
 */

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyBeginInput {
  /** Who owns the key, e.g. `user#<sub>`. Keys are scoped per principal. */
  scope: string;
  key: string;
  operation: string;
  /** Hash of the operation name and validated input; a reused key with a new request is rejected. */
  requestHash: string;
  now: Date;
  /** When an in-progress claim may be taken over (a crashed request). */
  lockUntil: Date;
  /** When the record is deleted by TTL. */
  expiresAt: Date;
}

export type IdempotencyBeginResult =
  | { status: 'started' }
  | { status: 'replay'; response: StoredResponse }
  | { status: 'in_progress' }
  | { status: 'mismatch'; operation: string };

export interface IdempotencyRepository {
  begin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult>;
  complete(scope: string, key: string, response: StoredResponse, expiresAt: Date): Promise<void>;
  /** Drops an in-progress claim so the caller can retry (used after a 5xx). */
  release(scope: string, key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  at: string;
  /** `user#<sub>` or `agent#<agentId>`. */
  principal: string;
  principalType: 'user' | 'agent' | 'anonymous';
  /** For agents: the team they play. */
  teamId: string | null;
  operation: string;
  leagueId: string | null;
  idempotencyKey: string | null;
  outcome: 'ok' | 'error';
  errorCode: string | null;
}

export interface AuditQuery {
  limit?: number;
}

export interface AuditRepository {
  record(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  listByLeague(leagueId: string, query?: AuditQuery): Promise<AuditEntry[]>;
  /** Newest first. */
  listByPrincipal(principal: string, query?: AuditQuery): Promise<AuditEntry[]>;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerRepository {
  get(id: string): Promise<Player | null>;
  getMany(ids: readonly string[]): Promise<Player[]>;
  putMany(players: readonly Player[]): Promise<void>;
  /** The name-search index: every player, or one position's shard. */
  listIndex(position?: Position): Promise<Player[]>;
}

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

export const LEAGUE_PHASES = [
  'setup',
  'drafting',
  'pre_lock',
  'waivers_open',
  'trade_deadline_passed',
  'playoffs',
  'complete'
] as const;
export type LeaguePhase = (typeof LEAGUE_PHASES)[number];

export interface League {
  id: string;
  name: string;
  season: number;
  phase: LeaguePhase;
  /** Current NFL week, or null before the season starts. */
  week: number | null;
  commissionerSub: string;
  teamCount: number;
  createdAt: string;
  updatedAt: string;
  /** Optimistic concurrency counter; incremented on every update. */
  version: number;
}

export interface LeagueRepository {
  get(leagueId: string): Promise<League | null>;
  /** Fails with a CONFLICT ApiError when the id already exists. */
  create(league: League): Promise<void>;
  /** Writes `league` with `version + 1` if the stored version equals `league.version`; else CONFLICT. */
  update(league: League): Promise<League>;
}

export interface Repos {
  idempotency: IdempotencyRepository;
  audit: AuditRepository;
  players: PlayerRepository;
  leagues: LeagueRepository;
}
