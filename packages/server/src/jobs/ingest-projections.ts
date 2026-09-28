import { createHash } from 'node:crypto';
import { LAST_NFL_WEEK, type Clock } from '@fantasy/core';
import type { ProjectionLine } from '@fantasy/data';
import { skipped, type JobDeps, type JobResult } from './deps.js';
import { inUniverse, universeIds } from './ingest-stats.js';

/** Stable content hash of a snapshot, so an unchanged hourly pull writes nothing. */
export function projectionHash(lines: readonly ProjectionLine[]): string {
  const canonical = [...lines]
    .sort((a, b) => a.playerId.localeCompare(b.playerId))
    .map((l) => [l.playerId, l.team ?? null, Object.entries(l.stats).sort(([a], [b]) => a.localeCompare(b))]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/**
 * The weeks worth projecting now: the current regular-season week and the next one. The next week
 * is always included because a league can already be playing it: a league drafted during week 3
 * starts with week 4 (the next week that has not kicked off, `firstScoringWeek`) while Sleeper's
 * NFL state still says week 3 until that week's last game. It is also waiver research once the
 * current week is under way. Preseason projects week 1.
 */
export async function projectionWeeks(
  deps: Pick<JobDeps, 'reference'>
): Promise<{ season: number; weeks: number[] } | null> {
  const state = await deps.reference.nflState.get();
  if (state === null) return null;
  if (state.seasonType === 'pre') return { season: state.leagueSeason, weeks: [1] };
  if (state.seasonType !== 'regular') return null;
  const week = Math.min(Math.max(state.week, 1), LAST_NFL_WEEK);
  return { season: state.season, weeks: week < LAST_NFL_WEEK ? [week, week + 1] : [week] };
}

/**
 * Projections (hourly). Stores each changed pull as an immutable snapshot
 * (`PROJ#<season>#W05#<capturedAt>` plus an `ASOF#<capturedAt>` pointer), so reads "as of" any
 * time see exactly what was known then.
 */
export async function ingestProjections(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'directory' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const target = await projectionWeeks(deps);
  if (target === null) return skipped('no_projection_week');
  const ids = await universeIds(deps.directory);
  const weeks: Record<string, unknown>[] = [];
  for (const week of target.weeks) {
    const lines = inUniverse(await deps.provider.getWeekProjections(target.season, week, now), ids);
    if (lines.length === 0) {
      weeks.push({ week, stored: false, reason: 'no_projections' });
      continue;
    }
    const hash = projectionHash(lines);
    const latest = await deps.reference.projections.latestSnapshot(target.season, week, now);
    if (latest?.hash === hash) {
      weeks.push({ week, stored: false, reason: 'unchanged' });
      continue;
    }
    await deps.reference.projections.putSnapshot(
      { season: target.season, week, capturedAt: now.toISOString(), hash, count: lines.length },
      lines
    );
    weeks.push({ week, stored: true, count: lines.length });
  }
  const result: JobResult = { status: 'ok', season: target.season, weeks };
  deps.log.info('projections ingested', result);
  return result;
}
