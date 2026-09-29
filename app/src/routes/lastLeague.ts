/**
 * The league you last opened, per browser (#212), so `/` takes you straight back into it. Storage
 * can be unavailable (a private window, blocked site data): then nothing is remembered.
 */
export const LAST_LEAGUE_KEY = 'aff:lastLeagueId';

export function readLastLeague(): string | null {
  try {
    const id = localStorage.getItem(LAST_LEAGUE_KEY);
    return id === null || id === '' ? null : id;
  } catch {
    return null;
  }
}

export function rememberLastLeague(leagueId: string): void {
  try {
    localStorage.setItem(LAST_LEAGUE_KEY, leagueId);
  } catch {
    // Blocked storage only means `/` shows My Leagues next time.
  }
}

export function forgetLastLeague(): void {
  try {
    localStorage.removeItem(LAST_LEAGUE_KEY);
  } catch {
    // Nothing could have been stored, then.
  }
}
