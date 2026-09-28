/** The slices of the API responses the players pages read (see packages/server/openapi.json). */

export interface PlayerRef {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

export interface Availability {
  status: 'free_agent' | 'waivers' | 'rostered';
  teamId?: string;
  clearsAt?: string;
}

export interface SearchPlayer extends PlayerRef {
  availability?: Availability;
}

export interface LeagueStateData {
  yourTeam: { id: string; name: string; faabRemaining: number } | null;
  allowedActions: string[];
  teams: { id: string; name: string }[];
}

export interface Issue {
  code: string;
  message: string;
  fix: string;
}

export interface ClaimPreview {
  wouldSucceed: boolean;
  outcome: 'add_now' | 'claim_pending' | 'blocked';
  issues: Issue[];
  processesAt: string | null;
  currentRoster: PlayerRef[];
  resultingRoster: PlayerRef[];
  faabRemaining: number;
  faabAfter: number;
}

export interface Claim {
  id: string;
  teamName: string;
  player: PlayerRef;
  drop: PlayerRef | null;
  bid: number;
  priority: number;
  status: string;
  processesAt: string;
}

export interface ClaimResult {
  outcome: 'added' | 'claim_pending';
  player: PlayerRef;
  claim: Claim | null;
}

/** "2026-09-13 08:00 UTC": a fixed, unambiguous form for waiver times. */
export function formatTime(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const fix = (error as { fix?: unknown }).fix;
    return typeof fix === 'string' ? `${error.message} ${fix}` : error.message;
  }
  return 'Something went wrong.';
}
