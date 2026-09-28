import type { Clock } from '@fantasy/core';
import type { EventDetailOf } from '../events/details.js';
import { NewsTagger } from '../players/tagging.js';
import type { NewsItem } from '../repos/reference.js';
import { mapLimit, type JobDeps, type JobResult } from './deps.js';
import type { FeedConfig } from './news/feeds.js';
import { newsId, normalizeArticleUrl, parseFeed } from './news/rss.js';

/** Items older than this are ignored, so a new feed (or a long outage) does not flood alerts. */
export const NEWS_MAX_AGE_MS = 3 * 86_400_000;
const FEED_CONCURRENCY = 4;

interface FeedOutcome {
  source: string;
  url: string;
  ok: boolean;
  entries: number;
  added: number;
  error?: string;
}

/**
 * News (every 15 minutes). Fetches the configured free RSS feeds, dedupes items by a hash of the
 * normalized article URL (a conditional put, so a story seen in two feeds or two runs is stored
 * once), tags them to players and teams by name, stores them with their publish time, and emits a
 * `Player News Alert` for each new item tagged to at least one player. A failing feed is logged
 * and skipped; it never fails the run. No LLM is involved: summaries come later.
 */
export async function ingestNews(
  deps: Pick<JobDeps, 'reference' | 'events' | 'directory' | 'log' | 'news'>,
  clock: Clock
): Promise<JobResult> {
  const now = clock.now();
  const [feeds, players] = await Promise.all([deps.news.feeds(), deps.directory.all()]);
  const tagger = new NewsTagger(players);
  const outcomes = await mapLimit(feeds, FEED_CONCURRENCY, (feed) => ingestFeed(deps, feed, tagger, now));
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) deps.log.warn('some news feeds failed', { failed });
  const added = outcomes.reduce((sum, o) => sum + o.added, 0);
  const result: JobResult = {
    status: 'ok',
    feeds: feeds.length,
    failedFeeds: failed.length,
    added,
    outcomes
  };
  deps.log.info('news ingested', { feeds: feeds.length, failedFeeds: failed.length, added });
  return result;
}

/** The `Player News Alert` detail for a stored news item tagged to at least one player. */
export function newsAlertDetail(item: NewsItem): EventDetailOf<'Player News Alert'> {
  return {
    newsId: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    playerIds: item.playerIds,
    teams: item.teams
  };
}

async function ingestFeed(
  deps: Pick<JobDeps, 'reference' | 'events' | 'log' | 'news'>,
  feed: FeedConfig,
  tagger: NewsTagger,
  now: Date
): Promise<FeedOutcome> {
  const outcome: FeedOutcome = { source: feed.source, url: feed.url, ok: true, entries: 0, added: 0 };
  let xml: string;
  try {
    xml = await deps.news.fetchText(feed.url);
  } catch (error) {
    return { ...outcome, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const entries = parseFeed(xml);
  outcome.entries = entries.length;
  const oldest = now.getTime() - NEWS_MAX_AGE_MS;
  for (const entry of entries) {
    const published =
      entry.publishedAt === null ? now.getTime() : Math.min(Date.parse(entry.publishedAt), now.getTime());
    if (published < oldest) continue;
    let url: string;
    try {
      url = normalizeArticleUrl(entry.url);
    } catch {
      continue;
    }
    const tags = tagger.tag(
      `${entry.title} ${entry.summary ?? ''}`,
      feed.team === undefined ? [] : [feed.team]
    );
    const item: NewsItem = {
      id: newsId(url),
      url,
      title: entry.title,
      source: feed.source,
      publishedAt: new Date(published).toISOString(),
      summary: entry.summary,
      playerIds: tags.playerIds,
      teams: tags.teams,
      ingestedAt: now.toISOString()
    };
    if (!(await deps.reference.news.add(item))) continue;
    outcome.added++;
    if (item.playerIds.length > 0) {
      await deps.events.publish('Player News Alert', newsAlertDetail(item));
    }
  }
  return outcome;
}
