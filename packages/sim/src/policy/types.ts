import type {
  DraftState,
  DraftablePlayer,
  LeagueSettings,
  LineupEntry,
  RosterPlayer,
  WeekGames
} from '@fantasy/core';
import type { TrendingEntry } from '@fantasy/data';

/** What a team sees when it is on the clock in the draft. */
export interface DraftContext {
  teamId: string;
  settings: LeagueSettings;
  draft: DraftState;
  /** Every undrafted player. */
  available: readonly DraftablePlayer[];
  /** Mean projected points per player over every week published before the draft (one week for a week-1 draft). */
  projections: Readonly<Record<string, number>>;
  seed: string;
}

/** What a team sees when it sets a lineup. */
export interface LineupContext {
  teamId: string;
  week: number;
  now: Date;
  settings: LeagueSettings;
  roster: readonly RosterPlayer[];
  currentLineup: readonly LineupEntry[];
  games: WeekGames;
  /** This week's projected points (pre-kickoff projections visible now). */
  projections: Readonly<Record<string, number>>;
}

export interface FreeAgent {
  player: RosterPlayer;
  /** This week's projected points (0 when none). */
  projection: number;
  /** Mean projected points over every week published so far (0 when none). */
  value: number;
  trending: boolean;
}

/** What a team sees before a waiver run. */
export interface WaiverContext {
  teamId: string;
  week: number;
  now: Date;
  settings: LeagueSettings;
  roster: readonly RosterPlayer[];
  faabRemaining: number;
  freeAgents: readonly FreeAgent[];
  trending: readonly TrendingEntry[];
  /** This week's projected points. */
  projections: Readonly<Record<string, number>>;
  /** Mean projected points over every week published so far. */
  values: Readonly<Record<string, number>>;
}

export interface ClaimRequest {
  addPlayerId: string;
  dropPlayerId: string | null;
  bid: number;
}

/**
 * A team's decision-maker. Scripted bots implement it deterministically; an agent-backed policy will
 * implement the same three decisions by calling league operations through its tools.
 */
export interface TeamPolicy {
  readonly name: string;
  draftPick(ctx: DraftContext): string | null | Promise<string | null>;
  lineup(ctx: LineupContext): LineupEntry[] | Promise<LineupEntry[]>;
  /** Claims in priority order (first is processed first). */
  waiverClaims(ctx: WaiverContext): ClaimRequest[] | Promise<ClaimRequest[]>;
}
