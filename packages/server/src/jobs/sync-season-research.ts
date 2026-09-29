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
 * How long a set that may still change (a preseason projection, a season missing weeks) goes
 * between checks. The job runs hourly so a new deployment or a new season fills the sets within
 * the hour (#181: a daily run left the draft room empty for most of a day after the first deploy);
 * this keeps the hourly runs from pulling 18 weeks from Sleeper every hour.
 */
export const RESEARCH_RECHECK_MS = 20 * 60 * 60 * 1000;

/**
 * Draft research data (hourly; a set is pulled when it is missing, and rechecked at most every
 * `RESEARCH_RECHECK_MS`). Last season's weekly stats are final, so they are pulled when a new
 * season begins (again only while the stored pull is missing weeks). During the regular season
 * this season's weekly stats are pulled too, so every completed week is stored even when the live
 * stats job missed it (a deploy mid-season, a missed game window): the player card's season so far. This season's weekly
 * projections are rechecked daily in the preseason and offseason, and in-season only while none
 * are stored or the stored pull is missing weeks. Each set is one `SEASON#<kind>#<season>`
 * partition, rewritten only when it changed; an unchanged check only stamps the meta's `checkedAt`.
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
    // The weeks each Sleeper endpoint served (v1, or the app fallback, #184), for the data status.
    const from = fetched.sources === undefined ? {} : { sources: fetched.sources };
    if (lines.length === 0) return { kind, season: year, stored: false, reason: 'no_data', ...from };
    const hash = seasonLinesHash(lines);
    const at = now.toISOString();
    if (stored?.hash === hash) {
      await seasons.putMeta({ ...stored, checkedAt: at });
      return { kind, season: year, stored: false, reason: 'unchanged', ...from };
    }
    await seasons.put(
      { kind, season: year, updatedAt: at, checkedAt: at, players: lines.length, weeks: fetched.weeks, hash },
      lines
    );
    return {
      kind,
      season: year,
      stored: true,
      players: lines.length,
      weeks: fetched.weeks.length,
      ...from
    };
  };

  const inSeason = state.seasonType === 'regular' || state.seasonType === 'post';
  const [statsMeta, projectionMeta, currentMeta] = await Promise.all([
    seasons.getMeta('stats', lastSeason),
    seasons.getMeta('projections', season),
    inSeason ? seasons.getMeta('stats', season) : Promise.resolve(null)
  ]);
  const checkedRecently = (meta: SeasonLinesMeta) =>
    now.getTime() - Date.parse(meta.checkedAt ?? meta.updatedAt) < RESEARCH_RECHECK_MS;
  const recent = (kind: SeasonLinesKind, year: number) => ({
    kind,
    season: year,
    stored: false,
    reason: 'checked_recently'
  });
  const sets: Record<string, unknown>[] = [];
  if (statsMeta !== null && statsMeta.weeks.length >= LAST_NFL_WEEK) {
    sets.push({ kind: 'stats', season: lastSeason, stored: false, reason: 'final' });
  } else if (statsMeta !== null && checkedRecently(statsMeta)) {
    sets.push(recent('stats', lastSeason));
  } else {
    sets.push(await refresh('stats', lastSeason, statsMeta));
  }
  const preseason = state.seasonType === 'pre' || state.seasonType === 'off' || season > state.season;
  if (projectionMeta !== null && projectionMeta.weeks.length >= LAST_NFL_WEEK && !preseason) {
    sets.push({ kind: 'projections', season, stored: false, reason: 'in_season' });
  } else if (projectionMeta !== null && checkedRecently(projectionMeta)) {
    sets.push(recent('projections', season));
  } else {
    sets.push(await refresh('projections', season, projectionMeta));
  }
  if (inSeason) {
    if (currentMeta !== null && checkedRecently(currentMeta)) sets.push(recent('stats', season));
    else sets.push(await refresh('stats', season, currentMeta));
  }
  const result: JobResult = { status: 'ok', season, lastSeason, sets };
  deps.log.info('season research synced', result);
  return result;
}
