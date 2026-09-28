import type { Instant } from '../rules/lineup.js';
import { ruleError, type RuleIssue } from '../rules/issues.js';
import type { Position } from '../rules/positions.js';
import { ruleFail, ruleOk, type RuleResult } from '../rules/result.js';
import { activeRosterSize, type LeagueSettings } from '../rules/settings.js';

/** Future hook: a pick that changed hands. Ownership is honoured by `pickOwner`; trading UI is not built yet. */
export interface TradedPick {
  round: number;
  /** The team whose slot in the draft order this pick is. */
  originalTeamId: string;
  /** The team that now makes the pick. */
  ownerTeamId: string;
}

export interface DraftPick {
  /** 1-based across the whole draft. */
  overall: number;
  round: number;
  /** 1-based within the round. */
  pick: number;
  /** The team that made the pick. */
  teamId: string;
  playerId: string;
  /** The drafted player's fantasy positions (the first is his primary position). */
  positions: readonly Position[];
  /** When the pick was made, from the caller's clock. */
  madeAt: string | null;
  /** True when the pick was made by autopick (timer expired or an agent fallback). */
  auto: boolean;
  /** The player's consensus rank (ADP stand-in) when he was picked; null when unranked. */
  adp?: number | null;
  /** Why the team made the pick, in its own words (an agent's reasoning summary). */
  reason?: string;
}

export interface DraftConfig {
  /** Round 1 draft order. Later rounds snake (reverse every other round). */
  teamIds: readonly string[];
  /** Rounds, normally the active roster size (`draftRoundsFor`). */
  rounds: number;
  /** Seconds each team has to pick. */
  pickSeconds: number;
  /** Optional per-team maximum of each primary position (e.g. { K: 1, DEF: 1 }). */
  positionLimits?: Partial<Record<Position, number>>;
  /** Future hook for traded picks. */
  tradedPicks?: readonly TradedPick[];
}

export interface DraftState {
  teamIds: readonly string[];
  rounds: number;
  pickSeconds: number;
  positionLimits: Partial<Record<Position, number>>;
  tradedPicks: readonly TradedPick[];
  picks: readonly DraftPick[];
}

export interface PickSlot {
  overall: number;
  round: number;
  pick: number;
  /** The team on the clock (the owner of the pick, after trades). */
  teamId: string;
}

/** Draft rounds for league settings: one per active roster spot (IR is not drafted). */
export function draftRoundsFor(settings: Pick<LeagueSettings, 'roster'>): number {
  return activeRosterSize(settings);
}

export function createDraft(config: DraftConfig): RuleResult<DraftState> {
  const issues: RuleIssue[] = [];
  const ids = config.teamIds;
  if (ids.length < 2) {
    issues.push(
      ruleError(
        'DRAFT_TOO_FEW_TEAMS',
        'teamIds',
        `A draft needs at least 2 teams; got ${ids.length}.`,
        'Pass every team in the league in round-1 draft order.'
      )
    );
  }
  if (new Set(ids).size !== ids.length || ids.includes('')) {
    issues.push(
      ruleError(
        'DRAFT_INVALID_TEAMS',
        'teamIds',
        'Draft order must list each team id exactly once, with no empty ids.',
        'Remove duplicates from teamIds.'
      )
    );
  }
  if (!Number.isInteger(config.rounds) || config.rounds < 1) {
    issues.push(
      ruleError(
        'DRAFT_INVALID_ROUNDS',
        'rounds',
        `rounds must be a whole number of at least 1; got ${config.rounds}.`,
        'Use draftRoundsFor(settings) (one round per active roster spot).'
      )
    );
  }
  if (!Number.isFinite(config.pickSeconds) || config.pickSeconds <= 0) {
    issues.push(
      ruleError(
        'DRAFT_INVALID_PICK_TIME',
        'pickSeconds',
        `pickSeconds must be positive; got ${config.pickSeconds}.`,
        'Set pickSeconds, e.g. 90.'
      )
    );
  }
  if (issues.length > 0) return ruleFail(issues);
  return ruleOk({
    teamIds: [...ids],
    rounds: config.rounds,
    pickSeconds: config.pickSeconds,
    positionLimits: { ...(config.positionLimits ?? {}) },
    tradedPicks: [...(config.tradedPicks ?? [])],
    picks: []
  });
}

export function totalPicks(draft: Pick<DraftState, 'teamIds' | 'rounds'>): number {
  return draft.teamIds.length * draft.rounds;
}

/** The team whose slot in the order a pick is (before trades): snake order. */
function originalTeamAt(draft: Pick<DraftState, 'teamIds'>, round: number, pick: number): string {
  const n = draft.teamIds.length;
  const index = round % 2 === 1 ? pick - 1 : n - pick;
  return draft.teamIds[index] as string;
}

function pickOwner(draft: DraftState, round: number, original: string): string {
  return (
    draft.tradedPicks.find((t) => t.round === round && t.originalTeamId === original)?.ownerTeamId ?? original
  );
}

/** The slot for an overall pick number (1-based), or null past the end of the draft. */
export function pickSlot(draft: DraftState, overall: number): PickSlot | null {
  if (!Number.isInteger(overall) || overall < 1 || overall > totalPicks(draft)) return null;
  const n = draft.teamIds.length;
  const round = Math.ceil(overall / n);
  const pick = overall - (round - 1) * n;
  return { overall, round, pick, teamId: pickOwner(draft, round, originalTeamAt(draft, round, pick)) };
}

/** Every pick slot in order. */
export function draftOrder(draft: DraftState): PickSlot[] {
  const out: PickSlot[] = [];
  for (let o = 1; o <= totalPicks(draft); o++) out.push(pickSlot(draft, o) as PickSlot);
  return out;
}

export function isComplete(draft: DraftState): boolean {
  return draft.picks.length >= totalPicks(draft);
}

/** The pick on the clock, or null when the draft is complete. */
export function currentPick(draft: DraftState): PickSlot | null {
  return pickSlot(draft, draft.picks.length + 1);
}

/** Picks until `teamId` is on the clock (0 = now), or null if it has no picks left. */
export function picksUntilTurn(draft: DraftState, teamId: string): number | null {
  for (let o = draft.picks.length + 1; o <= totalPicks(draft); o++) {
    if (pickSlot(draft, o)?.teamId === teamId) return o - draft.picks.length - 1;
  }
  return null;
}

/** Picks `teamId` still has to make, counting the one on the clock. */
export function picksRemaining(draft: DraftState, teamId: string): number {
  let n = 0;
  for (let o = draft.picks.length + 1; o <= totalPicks(draft); o++) {
    if (pickSlot(draft, o)?.teamId === teamId) n++;
  }
  return n;
}

export interface MakePickContext {
  /** The player's fantasy positions (primary first). Needed for position limits and autopick. */
  positions?: readonly Position[];
  /** When the pick was made, from the caller's clock. */
  now?: Instant;
  auto?: boolean;
}

export interface MadePick {
  draft: DraftState;
  pick: DraftPick;
}

function toIso(t: Instant): string {
  return (typeof t === 'string' ? new Date(t) : t).toISOString();
}

/** Picks a team has made so far. */
export function teamPicks(draft: DraftState, teamId: string): DraftPick[] {
  return draft.picks.filter((p) => p.teamId === teamId);
}

/** Count of a team's picks whose primary position is `position`. */
function primaryCount(draft: DraftState, teamId: string, position: Position): number {
  return teamPicks(draft, teamId).filter((p) => p.positions[0] === position).length;
}

/** Records a pick. The state is never mutated; the result holds the new state. */
export function makePick(
  draft: DraftState,
  teamId: string,
  playerId: string,
  context: MakePickContext = {}
): RuleResult<MadePick> {
  const slot = currentPick(draft);
  if (!slot) {
    return ruleFail([
      ruleError(
        'DRAFT_COMPLETE',
        'draft',
        `The draft is over; all ${totalPicks(draft)} picks have been made.`,
        'Add players through waivers or free agency instead.'
      )
    ]);
  }
  if (slot.teamId !== teamId) {
    const until = picksUntilTurn(draft, teamId);
    return ruleFail([
      ruleError(
        'NOT_YOUR_TURN',
        'teamId',
        `It is ${slot.teamId}'s pick (round ${slot.round}, pick ${slot.pick}), not ${teamId}'s.`,
        until === null
          ? `${teamId} has no picks left in this draft.`
          : `Wait ${until} more pick(s); ${teamId} is on the clock after that. Queue players in the meantime.`,
        { onTheClock: slot.teamId, picksUntilYourTurn: until }
      )
    ]);
  }
  const taken = draft.picks.find((p) => p.playerId === playerId);
  if (taken) {
    return ruleFail([
      ruleError(
        'PLAYER_ALREADY_DRAFTED',
        'playerId',
        `${playerId} was already drafted by ${taken.teamId} (round ${taken.round}, pick ${taken.pick}).`,
        'Pick a player who is still available.',
        { draftedBy: taken.teamId, round: taken.round, pick: taken.pick, overall: taken.overall }
      )
    ]);
  }
  const positions = context.positions ?? [];
  const primary = positions[0];
  if (primary !== undefined) {
    const limit = draft.positionLimits[primary];
    if (limit !== undefined && primaryCount(draft, teamId, primary) >= limit) {
      return ruleFail([
        ruleError(
          'ROSTER_POSITION_LIMIT',
          'playerId',
          `${teamId} already has ${limit} ${primary}(s), the league maximum.`,
          `Pick a player at another position (${primary} is full).`,
          { position: primary, limit }
        )
      ]);
    }
  }
  const pick: DraftPick = {
    overall: slot.overall,
    round: slot.round,
    pick: slot.pick,
    teamId,
    playerId,
    positions: [...positions],
    madeAt: context.now === undefined ? null : toIso(context.now),
    auto: context.auto ?? false
  };
  return ruleOk({ draft: { ...draft, picks: [...draft.picks, pick] }, pick });
}

/**
 * When the team on the clock must pick by: `pickSeconds` after the previous pick was made, or after
 * `startedAt` for the first pick (or when the previous pick has no time). Null once the draft is
 * complete. Pure: the server schedules the autopick at this time.
 */
export function deadlineFor(draft: DraftState, startedAt: Instant): Date | null {
  if (isComplete(draft)) return null;
  const last = draft.picks[draft.picks.length - 1];
  const from = last?.madeAt ?? toIso(startedAt);
  return new Date(new Date(from).getTime() + draft.pickSeconds * 1000);
}
