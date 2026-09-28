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
  picks: (DraftSlot & { teamId: string; player: PlayerRef; auto: boolean; madeAt: string | null })[];
  rosters: { teamId: string; teamName: string; players: PlayerRef[] }[];
  bestAvailable: { player: PlayerRef; rank: number | null }[];
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
