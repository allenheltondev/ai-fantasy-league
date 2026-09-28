import type { Clock } from '@fantasy/core';
import type { TrendingEntry, TrendingType } from '@fantasy/data';
import type { JobDeps, JobResult } from './deps.js';

/** Lookback windows cached each hour; get_trending_players serves the closest one. */
export const TRENDING_LOOKBACKS_HOURS = [24, 72, 168] as const;
/** Entries kept per window (Sleeper returns the top N by count). */
export const TRENDING_LIMIT = 50;
export const TRENDING_TYPES: readonly TrendingType[] = ['add', 'drop'];

/**
 * Trending adds and drops (hourly). One snapshot per type under `TRENDING#<type>`/`ASOF#<ts>`,
 * holding every cached lookback window. Six small Sleeper calls an hour.
 */
export async function ingestTrending(
  deps: Pick<JobDeps, 'provider' | 'reference' | 'log'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const capturedAt = now.toISOString();
  const counts: Record<string, number> = {};
  for (const type of TRENDING_TYPES) {
    const lookbacks: Record<string, TrendingEntry[]> = {};
    for (const hours of TRENDING_LOOKBACKS_HOURS) {
      const entries = await deps.provider.getTrending(type, now, {
        lookbackHours: hours,
        limit: TRENDING_LIMIT
      });
      lookbacks[String(hours)] = entries;
      counts[`${type}_${hours}h`] = entries.length;
    }
    await deps.reference.trending.put({ type, capturedAt, lookbacks });
  }
  return { status: 'ok', capturedAt, counts };
}
