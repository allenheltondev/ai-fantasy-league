import { createHash } from 'node:crypto';
import { LAST_NFL_WEEK, type Clock } from '@fantasy/core';
import {
  DataNotAvailableError,
  fetchSeasonLines,
  type PlayerSeasonLines,
  type SeasonLinesKind
} from '@fantasy/data';
import { researchSeasons } from '../players/research.js';
import type { SeasonLinesMeta } from '../repos/reference.js';
import { skipped, type JobDeps, type JobResult } from './deps.js';
import { inUniverse, universeIds } from './ingest-stats.js';

/** Stable content hash of a season set (lines are sorted by player; stat keys are sorted here). */
export function seasonLinesHash(lines: readonly PlayerSeasonLines[]): string {
  const canonical = lines.map((l) => [
    l.playerId,
    l.team ?? null,
    l.weeks.map((w) => [w.week, Object.entries(w.stats).sort(([a], [b]) => a.localeCompare(b))])
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/**
 * Draft research data (daily). Last season's weekly stats are final, so they are pulled once when
 * a new season begins (again only while the stored pull is missing weeks). This season's weekly
 * projections are pulled every day in the preseason and offseason, and once in-season if none are
 * stored yet or the stored pull is missing weeks. Each set is one `SEASON#<kind>#<season>` partition, rewritten only when it changed.
 */
export async function syncSeasonResearch(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'directory' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const state = await deps.reference.nflState.get();
  if (state === null) return skipped('no_nfl_state');
  const { season, lastSeason } = researchSeasons(state);
  const ids = await universeIds(deps.directory);
  const seasons = deps.reference.seasons;

  const refresh = async (
    kind: SeasonLinesKind,
    year: number,
    stored: SeasonLinesMeta | null
  ): Promise<Record<string, unknown>> => {
    let fetched;
    try {
      fetched = await fetchSeasonLines(deps.provider, kind, year, now);
    } catch (error) {
      // A historical source (the replay simulator) may not hold that season at all.
      if (error instanceof DataNotAvailableError)
        return { kind, season: year, stored: false, reason: 'no_data' };
      throw error;
    }
    const lines = inUniverse(fetched.lines, ids);
    if (lines.length === 0) return { kind, season: year, stored: false, reason: 'no_data' };
    const hash = seasonLinesHash(lines);
    if (stored?.hash === hash) return { kind, season: year, stored: false, reason: 'unchanged' };
    await seasons.put(
      { kind, season: year, updatedAt: now.toISOString(), players: lines.length, weeks: fetched.weeks, hash },
      lines
    );
    return { kind, season: year, stored: true, players: lines.length, weeks: fetched.weeks.length };
  };

  const [statsMeta, projectionMeta] = await Promise.all([
    seasons.getMeta('stats', lastSeason),
    seasons.getMeta('projections', season)
  ]);
  const sets: Record<string, unknown>[] = [];
  sets.push(
    statsMeta === null || statsMeta.weeks.length < LAST_NFL_WEEK
      ? await refresh('stats', lastSeason, statsMeta)
      : { kind: 'stats', season: lastSeason, stored: false, reason: 'final' }
  );
  const preseason = state.seasonType === 'pre' || state.seasonType === 'off' || season > state.season;
  sets.push(
    projectionMeta === null || projectionMeta.weeks.length < LAST_NFL_WEEK || preseason
      ? await refresh('projections', season, projectionMeta)
      : { kind: 'projections', season, stored: false, reason: 'in_season' }
  );
  const result: JobResult = { status: 'ok', season, lastSeason, sets };
  deps.log.info('season research synced', result);
  return result;
}
