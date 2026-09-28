/** The `get_draft_board` response (packages/server/src/operations/draft/board.ts). */

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
  order: { teamId: string; teamName: string; seatType: 'human' | 'agent' }[];
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
