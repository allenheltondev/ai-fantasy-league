import { isApiError } from '../errors.js';
import type { League, Repos } from '../repos/types.js';

/** Retry a small recovery checkpoint against fresh league metadata, without replaying its work. */
export async function updateRecovery(
  repos: Pick<Repos, 'leagues'>,
  leagueId: string,
  change: (league: League) => League | null
): Promise<League | null> {
  for (let attempt = 0; ; attempt++) {
    const latest = await repos.leagues.get(leagueId);
    if (latest === null) return null;
    const next = change(latest);
    if (next === null) return latest;
    try {
      return await repos.leagues.update(next);
    } catch (error) {
      if (!isApiError(error) || error.code !== 'CONFLICT' || attempt === 3) throw error;
    }
  }
}
