import type {
  Bracket,
  Clock,
  DraftPick,
  DraftState,
  LeagueSettings,
  LineupEntry,
  RuleIssue,
  ScheduleWeek,
  StandingsRow
} from '@fantasy/core';
import type { DataProvider } from '@fantasy/data';

/** Result of an engine operation: the value plus advisory warnings, or the blocking issues (each with a fix). */
export type EngineResult<T> =
  { ok: true; value: T; warnings: RuleIssue[] } | { ok: false; issues: RuleIssue[] };

export type LeaguePhase = 'drafting' | 'in_season' | 'playoffs' | 'complete';

/** What an engine runs against: the simulated clock and the (as-of guarded) data provider. */
export interface EngineEnv {
  clock: Clock;
  data: DataProvider;
  season: number;
}

export interface CreateLeagueInput {
  leagueId: string;
  settings: LeagueSettings;
  teams: readonly { id: string; name: string }[];
  /** Round-1 draft order (team ids). Waiver priority starts as its reverse. */
  draftOrder: readonly string[];
  /** Seeds the schedule and the standings coin flip. */
  seed: string;
}

export interface TeamView {
  id: string;
  name: string;
  faabRemaining: number;
  /** Players on the roster with their current slots. */
  roster: LineupEntry[];
}

export interface LeagueView {
  leagueId: string;
  settings: LeagueSettings;
  phase: LeaguePhase;
  /** The week the league is playing or about to play. */
  week: number;
  teams: TeamView[];
  schedule: ScheduleWeek[];
  waiverOrder: string[];
}

export interface WaiverClaimInput {
  teamId: string;
  addPlayerId: string;
  dropPlayerId?: string | null;
  bid: number;
  /** The team's ranking of its claims: 1 is processed first. */
  priority: number;
}

export type Transaction =
  | {
      seq: number;
      type: 'draft_pick';
      at: string;
      teamId: string;
      playerId: string;
      round: number;
      overall: number;
    }
  | {
      seq: number;
      type: 'waiver_add';
      at: string;
      week: number;
      teamId: string;
      addPlayerId: string;
      dropPlayerId: string | null;
      cost: number;
    };

export interface WaiverRunResult {
  week: number;
  awarded: { teamId: string; addPlayerId: string; dropPlayerId: string | null; cost: number }[];
  failed: { teamId: string; addPlayerId: string; code: string }[];
}

export interface MatchupScore {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  /** Null for a tie (a playoff tie goes to the better seed; see the bracket). */
  winnerTeamId: string | null;
}

export interface WeekScoreboard {
  week: number;
  kind: 'regular' | 'playoffs';
  /** `live` while games are in progress, then `provisional` (Monday night) and `official` (Thursday). */
  stage: 'live' | 'provisional' | 'official';
  matchups: MatchupScore[];
  /** Every team's starter points, including teams without a game this week. */
  teamPoints: Record<string, number>;
}

/** One saved lineup, for lock auditing. */
export interface LineupRecord {
  at: string;
  week: number;
  teamId: string;
  lineup: LineupEntry[];
}

/**
 * The league operations a season replay needs. `CoreOnlyEngine` implements them in memory on
 * `@fantasy/core`; a server-backed engine will implement the same interface by calling the operation
 * registry, so the runner and policies never change. Every operation reads time from the engine's clock.
 */
export interface LeagueEngine {
  /** A short name for reports, e.g. `core-only`. */
  readonly kind: string;
  createLeague(input: CreateLeagueInput): Promise<LeagueView>;
  league(): Promise<LeagueView>;
  /** The draft (picks so far, order, rounds). */
  draft(): Promise<DraftState>;
  makeDraftPick(teamId: string, playerId: string): Promise<EngineResult<DraftPick>>;
  lineup(teamId: string, week: number): Promise<LineupEntry[]>;
  setLineup(
    teamId: string,
    week: number,
    lineup: readonly LineupEntry[]
  ): Promise<EngineResult<LineupEntry[]>>;
  submitWaiverClaim(claim: WaiverClaimInput): Promise<EngineResult<{ claimId: string }>>;
  processWaivers(week: number): Promise<WaiverRunResult>;
  /** Live scores from the stats known now. */
  scoreWeek(week: number): Promise<WeekScoreboard>;
  /** Records the week's results: `provisional` on Monday night, `official` after stat corrections. */
  finalizeWeek(week: number, stage: 'provisional' | 'official'): Promise<WeekScoreboard>;
  standings(): Promise<StandingsRow[]>;
  bracket(): Promise<Bracket | null>;
  champion(): Promise<string | null>;
  transactions(): Promise<Transaction[]>;
  /** Every saved lineup in order, for the lock invariant. */
  lineupHistory(): Promise<LineupRecord[]>;
}

/** Builds an engine for a run. The runner supplies the simulated clock and the guarded provider. */
export type LeagueEngineFactory = (env: EngineEnv) => LeagueEngine;
