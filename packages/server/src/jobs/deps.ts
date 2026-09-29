import type { Clock } from '@fantasy/core';
import type { DataProvider } from '@fantasy/data';
import type { KillSwitch } from '../agents/kill-switch.js';
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
  /** League repositories, for league jobs: waiver processing, live scoring, the weekly cycle. */
  repos: Repos;
  events: EventPublisher;
  directory: PlayerDirectory;
  log: Logger;
  news: NewsSource;
  /** Report achievements to the rsc-core badge chest (`BADGE_CHEST_ENABLED`); off by default. */
  badgeChest?: boolean;
  /** The agent kill switch (`AGENT_KILL_SWITCH_PARAM`): no manager check-ins while it is on. */
  agentKillSwitch?: KillSwitch;
}

export interface JobResult {
  status: 'ok' | 'skipped';
  /** Why a run did nothing (outside a game window, unchanged data, ...). */
  reason?: string;
  [metric: string]: unknown;
}

export type Job = (deps: JobDeps, clock: Clock) => Promise<JobResult>;

/**
 * Finish all, then fail: a league job keeps going past a league that fails (logging it), and once
 * every league is done this throws if any failed, so the invocation fails, Lambda retries it (the
 * league jobs are idempotent, so leagues that succeeded are no-ops on the retry), and the failure
 * reaches the OnFailure destination and its email (FailureNotifierFunction, #130).
 */
export function settle(log: Logger, job: string, result: JobResult): JobResult {
  const failed = typeof result.failed === 'number' ? result.failed : 0;
  if (failed === 0) return result;
  log.info(`${job} partly done`, { ...result });
  throw new Error(`${job}: ${failed} failed after the rest finished (see the error logs for which)`);
}

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
