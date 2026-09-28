import type { DraftState, LeagueSettings, LineupEntry, StandingsRow } from '@fantasy/core';
import type { Player, Position } from '../players/model.js';
import type { ChatRepository } from '../chat/model.js';
import type { AgentRepository } from './agents.js';
import type { HistoryRepository } from './history.js';
import type { WaiverRepository } from './waivers.js';

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
// Leagues (docs/adr/001-table-design.md, "League partition")
// ---------------------------------------------------------------------------

/**
 * The league lifecycle, in order. Sub-phase conditions (waivers open, pre-lock, trade deadline
 * passed) are flags derived from the league and the clock; see `league/phase.ts`.
 */
export const LEAGUE_PHASES = ['setup', 'drafting', 'regular_season', 'playoffs', 'complete'] as const;
export type LeaguePhase = (typeof LEAGUE_PHASES)[number];

/** Upcoming times that decide the sub-phase flags. Written by the season jobs; null until known. */
export interface LeagueDeadlines {
  /** When the draft is scheduled to start. */
  draftStartsAt: string | null;
  /** The next lineup lock (first kickoff of the current week). */
  nextLineupLockAt: string | null;
  /** When pending waiver claims are next processed. */
  nextWaiverRunAt: string | null;
  /** When the trade deadline passes (kickoff of `trades.deadlineWeek`). */
  tradeDeadlineAt: string | null;
}

export interface League {
  id: string;
  name: string;
  /** NFL season year (2026 for the 2026-27 season). */
  season: number;
  phase: LeaguePhase;
  /** Current NFL week, or null before the season starts. */
  week: number | null;
  settings: LeagueSettings;
  /** The commissioner's user id (Cognito `sub`). Always a human who holds a seat. */
  commissionerId: string;
  commissionerName: string;
  /** Who created the league; counts toward that user's league quota. */
  createdBy: string;
  /** Seed for the regular-season schedule, so it can always be regenerated identically. */
  scheduleSeed: string;
  deadlines: LeagueDeadlines;
  createdAt: string;
  updatedAt: string;
  /** Optimistic concurrency counter; incremented on every update. */
  version: number;
}

export interface LeagueRepository {
  get(leagueId: string): Promise<League | null>;
  /** Leagues by id, in the given order, skipping ids that do not exist. */
  getMany(leagueIds: readonly string[]): Promise<League[]>;
  /** Fails with a CONFLICT ApiError when the id already exists. */
  create(league: League): Promise<void>;
  /** Writes `league` with `version + 1` if the stored version equals `league.version`; else CONFLICT. */
  update(league: League): Promise<League>;
  /** Every league this user created (GSI1 `CREATOR#<sub>`), oldest first. */
  listByCreator(userId: string): Promise<League[]>;
  /** Every league in a phase (GSI2 `LEAGUEPHASE#<phase>`), for scheduled jobs such as waiver processing. */
  listByPhase(phase: LeaguePhase): Promise<League[]>;
  /** Deletes the whole league partition: the league, its teams, members, invites, and schedule. */
  delete(leagueId: string): Promise<void>;
}

export const SEAT_TYPES = ['human', 'agent'] as const;
export type SeatType = (typeof SEAT_TYPES)[number];

/**
 * A team is one seat. A `human` seat with no owner is open and waiting for an invitee; an `agent`
 * seat is played by an AI agent until someone joins and claims it.
 */
export interface Team {
  id: string;
  leagueId: string;
  name: string;
  seatType: SeatType;
  /** The human owner's user id; null for agent seats and open human seats. */
  ownerUserId: string | null;
  ownerName: string | null;
  /** The agent config (personality, difficulty, model) for agent seats; null until configured. */
  agentConfigId: string | null;
  /** 1-based position in the round-1 draft order. */
  draftSlot: number;
  faabRemaining: number;
  /** 1 is first in line for waivers. */
  waiverPriority: number;
  /** Player ids. Empty until the draft. */
  roster: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TeamRepository {
  /** Every team in the league, in draft-slot order. */
  list(leagueId: string): Promise<Team[]>;
  get(leagueId: string, teamId: string): Promise<Team | null>;
  /** Creates teams that must not exist yet (CONFLICT otherwise). */
  create(teams: readonly Team[]): Promise<void>;
  /** Version-checked write, like `LeagueRepository.update`. */
  update(team: Team): Promise<Team>;
  /** Deletes a team only if it has no human owner; returns false when it has one. */
  deleteUnowned(leagueId: string, teamId: string): Promise<boolean>;
}

/** Membership index: one item per human seat holder, so "my leagues" is one GSI1 query. */
export interface Member {
  leagueId: string;
  userId: string;
  teamId: string;
  joinedAt: string;
}

export interface MemberRepository {
  get(leagueId: string, userId: string): Promise<Member | null>;
  /** Adds the member; returns false when the user already has a seat in the league. */
  add(member: Member): Promise<boolean>;
  remove(leagueId: string, userId: string): Promise<void>;
  /** Every league membership of a user (GSI1 `USER#<sub>`). */
  listByUser(userId: string): Promise<Member[]>;
}

export interface Invite {
  id: string;
  leagueId: string;
  /** SHA-256 of the invite token. The token itself is never stored. */
  tokenHash: string;
  /** When set, only a user signed in with this email can use the invite. */
  email: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface InviteRepository {
  create(invite: Invite): Promise<void>;
  get(leagueId: string, inviteId: string): Promise<Invite | null>;
  getByTokenHash(tokenHash: string): Promise<Invite | null>;
  /** Newest first. */
  list(leagueId: string): Promise<Invite[]>;
  /** Version-checked write; CONFLICT when the invite changed. */
  update(invite: Invite): Promise<Invite>;
}

export interface Matchup {
  id: string;
  leagueId: string;
  week: number;
  kind: 'regular' | 'playoff';
  homeTeamId: string;
  awayTeamId: string;
  /** Null until the week is scored. */
  homeScore: number | null;
  awayScore: number | null;
  status: 'scheduled' | 'in_progress' | 'final';
}

export interface StandingsSnapshot {
  leagueId: string;
  /** The last week included. */
  week: number;
  rows: StandingsRow[];
  computedAt: string;
}

export interface ScheduleRepository {
  /** Writes matchups, overwriting any with the same week and id. */
  putMatchups(matchups: readonly Matchup[]): Promise<void>;
  /** Every matchup, or one week's, ordered by week then id. */
  listMatchups(leagueId: string, week?: number): Promise<Matchup[]>;
  putStandings(snapshot: StandingsSnapshot): Promise<void>;
  /** The snapshot for the latest week, or null before any week is final. */
  latestStandings(leagueId: string): Promise<StandingsSnapshot | null>;
}

/** A team's lineup for one week (`LINEUP#W05#<teamId>`). */
export interface Lineup {
  leagueId: string;
  teamId: string;
  week: number;
  /** Every rostered player with his slot. */
  entries: LineupEntry[];
  updatedAt: string;
  /** `user#<sub>`, `agent#<agentId>`, or `system` when the season cycle carried it forward. */
  updatedBy: string;
}

export interface LineupRepository {
  get(leagueId: string, teamId: string, week: number): Promise<Lineup | null>;
  /** The team's lineup for the latest week at or before `week`, or null when it has none. */
  latest(leagueId: string, teamId: string, week: number): Promise<Lineup | null>;
  /** Writes lineups, replacing any for the same team and week. */
  put(lineups: readonly Lineup[]): Promise<void>;
  /** Every team's lineup for one week. */
  listWeek(leagueId: string, week: number): Promise<Lineup[]>;
}

// ---------------------------------------------------------------------------
// Draft (`DRAFT` in the league partition)
// ---------------------------------------------------------------------------

export const DRAFT_STATUSES = ['in_progress', 'paused', 'complete'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/**
 * The live draft: the core snake-draft state (order, rounds, clock, every pick) plus the clock
 * deadline. Picks live on this one item, so a pick is one version-checked write: two racing picks
 * can never both land.
 */
export interface DraftRecord {
  leagueId: string;
  state: DraftState;
  status: DraftStatus;
  startedAt: string;
  /** When the team on the clock must pick; null while paused and once complete. */
  deadline: string | null;
  /** Seconds that were left on the clock when the commissioner paused the draft. */
  pausedRemainingSeconds: number | null;
  completedAt: string | null;
  updatedAt: string;
  version: number;
}

export interface DraftRepository {
  get(leagueId: string): Promise<DraftRecord | null>;
  /** Fails with CONFLICT when the league already has a draft. */
  create(draft: DraftRecord): Promise<void>;
  /** Writes `draft` with `version + 1` if the stored version equals `draft.version`; else CONFLICT. */
  update(draft: DraftRecord): Promise<DraftRecord>;
}

export interface Repos {
  idempotency: IdempotencyRepository;
  audit: AuditRepository;
  players: PlayerRepository;
  leagues: LeagueRepository;
  teams: TeamRepository;
  members: MemberRepository;
  invites: InviteRepository;
  schedule: ScheduleRepository;
  lineups: LineupRepository;
  drafts: DraftRepository;
  /** Agent seats, notes, task records, and usage rollups (repos/agents.ts). */
  agents: AgentRepository;
  /** Waiver claims, the waiver wire, transactions, processing runs, and ownership locks (repos/waivers.ts). */
  waivers: WaiverRepository;
  /** League group chat (chat/model.ts). */
  chat: ChatRepository;
  /** Playoff brackets, official finals, season archives, and achievements (repos/history.ts). */
  history: HistoryRepository;
}
