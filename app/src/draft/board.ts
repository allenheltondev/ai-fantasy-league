/** The `get_draft_board` response (packages/server/src/operations/draft/board.ts). */

import type { Manager } from '../api/types';

export interface PlayerRef {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

export interface DraftSlot {
  overall: number;
  round: number;
  pick: number;
}

export interface DraftBoard {
  status: 'in_progress' | 'paused' | 'complete';
  rounds: number;
  pickSeconds: number;
  startedAt: string;
  completedAt: string | null;
  order: { teamId: string; teamName: string; seatType: 'human' | 'agent'; manager?: Manager | null }[];
  onTheClock:
    | (DraftSlot & { teamId: string; teamName: string; deadline: string | null; secondsLeft: number | null })
    | null;
  yourTeamId: string | null;
  yourNextPick: (DraftSlot & { picksAway: number }) | null;
  yourNeeds: string[];
  picks: (DraftSlot & {
    teamId: string;
    player: PlayerRef;
    auto: boolean;
    madeAt: string | null;
    adp?: number | null;
    /** Why the team made the pick (an agent's reasoning). */
    reason?: string | null;
  })[];
  /** Once the draft is complete: its steals, reaches, and each agent's first pick. */
  recap?: DraftRecap | null;
  rosters: { teamId: string; teamName: string; players: PlayerRef[] }[];
  bestAvailable: BestAvailableEntry[];
  /** Your drafted roster by slot (#170); null with no team. Absent from older servers. */
  yourRoster?: YourRoster | null;
  /** Players the other teams will likely take before your next pick (#170). */
  likelyGone?: PlayerRef[];
  /** Per position: how many of the 100 best available play it, and how many will likely go first. */
  scarcity?: PositionScarcity[];
}

export interface YourRoster {
  starters: { slot: string; player: PlayerRef | null }[];
  bench: PlayerRef[];
  benchSize: number;
}

export interface PositionScarcity {
  position: string;
  left: number;
  likelyGone: number;
}

/** One undrafted player, with last season and the projection under the league's scoring (#136). */
export interface BestAvailableEntry {
  player: PlayerRef;
  rank: number | null;
  lastSeason?: { points: number; ppg: number; games: number } | null;
  projection?: { points: number } | null;
  bye?: number | null;
  injuryStatus?: string | null;
}

export interface DraftRecapEntry {
  overall: number;
  round: number;
  teamId: string;
  teamName: string;
  player: PlayerRef;
  adp: number | null;
  /** Picks after ADP: positive for a steal, negative for a reach. */
  value: number | null;
  reason: string | null;
}

export interface DraftRecap {
  steals: DraftRecapEntry[];
  reaches: DraftRecapEntry[];
  agentPicks: DraftRecapEntry[];
}

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as const;

/** Overall pick number for a round and a round-1 draft position (0-based): a snake. */
export function overallPick(round: number, index: number, teams: number): number {
  const inRound = round % 2 === 1 ? index + 1 : teams - index;
  return (round - 1) * teams + inRound;
}

/** Seconds until `deadline` (never negative). */
export function secondsUntil(deadline: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
}

/** `m:ss`. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The team picking at `overall` (1-based) in a snake draft over `order`. */
export function teamAt<T>(order: readonly T[], overall: number): T | undefined {
  const n = order.length;
  if (n === 0 || overall < 1) return undefined;
  const round = Math.ceil(overall / n);
  const inRound = overall - (round - 1) * n;
  return order[round % 2 === 1 ? inRound - 1 : n - inRound];
}

/** "2.03": round and pick within the round, as draft boards write it. */
export function roundPick(round: number, pick: number): string {
  return `${round}.${String(pick).padStart(2, '0')}`;
}

/** Empty starting seats grouped by slot, in seat order: "1 TE, 1 DEF, 1 K". */
export function needsLine(starters: readonly { slot: string; player: unknown }[]): string {
  const counts = new Map<string, number>();
  for (const s of starters) if (s.player === null) counts.set(s.slot, (counts.get(s.slot) ?? 0) + 1);
  return [...counts].map(([slot, n]) => `${n} ${slot}`).join(', ');
}

/**
 * Needs from `yourNeeds` (older servers, or before the roster loads): the same grouping over a flat
 * list of empty slots.
 */
export function needsFromSlots(slots: readonly string[]): string {
  return needsLine(slots.map((slot) => ({ slot, player: null })));
}

/** "J. Chase": a first initial and the rest, for tight spots (defenses keep their full name). */
export function shortName(player: Pick<PlayerRef, 'name' | 'position'>): string {
  if (player.position === 'DEF') return player.name;
  const [first, ...rest] = player.name.split(' ');
  return rest.length === 0 || first === undefined ? player.name : `${first.charAt(0)}. ${rest.join(' ')}`;
}

/**
 * Position colors, as on a pro draft board, from the design-system tokens only (so they hold in
 * light and dark): `chip` for a small label, `cell` for a board square.
 */
export const POSITION_TONES: Readonly<Record<string, { chip: string; cell: string }>> = {
  QB: { chip: 'bg-error-100 text-error-800', cell: 'bg-error-50 border-error-500' },
  RB: { chip: 'bg-success-100 text-success-800', cell: 'bg-success-50 border-success-500' },
  WR: { chip: 'bg-primary-100 text-primary-800', cell: 'bg-primary-50 border-primary-500' },
  TE: { chip: 'bg-warning-100 text-warning-800', cell: 'bg-warning-50 border-warning-500' },
  K: { chip: 'bg-secondary-100 text-secondary-800', cell: 'bg-secondary-50 border-secondary-400' },
  DEF: { chip: 'bg-secondary-200 text-secondary-900', cell: 'bg-secondary-100 border-secondary-700' }
};

const NEUTRAL_TONE = { chip: 'bg-muted text-foreground', cell: 'bg-muted border-border' };

export function positionTone(position: string): { chip: string; cell: string } {
  return POSITION_TONES[position] ?? NEUTRAL_TONE;
}
