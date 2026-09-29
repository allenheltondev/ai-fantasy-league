/** The slices of the API responses the transaction log reads (see packages/server/openapi.json). */

export interface PlayerRef {
  id: string;
  name: string;
  team: string | null;
  position: string;
}

/** One move from list_transactions. */
export interface Transaction {
  id: string;
  at: string;
  week: number;
  type: 'add' | 'drop' | 'waiver_claim';
  teamId: string;
  teamName: string;
  added: PlayerRef | null;
  dropped: PlayerRef | null;
  cost: number | null;
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
