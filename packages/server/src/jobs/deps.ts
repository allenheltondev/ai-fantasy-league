import type { Clock } from '@fantasy/core';
import type { DataProvider } from '@fantasy/data';
import type { EventPublisher } from '../events/publisher.js';
import type { Logger } from '../log.js';
import type { PlayerDirectory } from '../players/directory.js';
import type { ReferenceStore } from '../repos/reference.js';
import type { Repos } from '../repos/types.js';
import type { FeedConfig } from './news/feeds.js';

/** Where news comes from: the configured feeds and a way to fetch one. */
export interface NewsSource {
  feeds(): Promise<FeedConfig[]>;
  fetchText(url: string): Promise<string>;
}

/**
 * Everything the scheduled jobs use. Tests pass a fixture `DataProvider`, the in-memory reference
 * store, and an in-memory event publisher; the Lambda passes live and DynamoDB implementations.
 */
export interface JobDeps {
  provider: DataProvider;
  reference: ReferenceStore;
  /** League repositories, for league jobs such as waiver processing. */
  repos: Repos;
  events: EventPublisher;
  directory: PlayerDirectory;
  log: Logger;
  news: NewsSource;
}

export interface JobResult {
  status: 'ok' | 'skipped';
  /** Why a run did nothing (outside a game window, unchanged data, ...). */
  reason?: string;
  [metric: string]: unknown;
}

export type Job = (deps: JobDeps, clock: Clock) => Promise<JobResult>;

export function skipped(reason: string, extra: Record<string, unknown> = {}): JobResult {
  return { status: 'skipped', reason, ...extra };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
