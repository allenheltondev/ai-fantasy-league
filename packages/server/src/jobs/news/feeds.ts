import { z } from 'zod';
import { NFL_TEAMS } from '../../players/model.js';
import defaultFeeds from './default-feeds.json' with { type: 'json' };

export const FeedConfigSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  /** The outlet's name, shown with every item. */
  source: z.string().min(1),
  /** For a team's own feed: every item is tagged to this team. */
  team: z.enum(NFL_TEAMS).optional()
});
export type FeedConfig = z.infer<typeof FeedConfigSchema>;

const FeedListSchema = z.array(FeedConfigSchema).min(1);

/** Free NFL news RSS feeds (docs/data-sources.md). Used when no override is configured. */
export const DEFAULT_FEEDS: readonly FeedConfig[] = FeedListSchema.parse(defaultFeeds);

/** The SSM value (or `NEWS_FEEDS` env value) that means "use the built-in list". */
export const DEFAULT_FEEDS_SENTINEL = 'defaults';

/**
 * Parses a feed list: `defaults`, a JSON array of `{ url, source, team? }`, or one URL per line
 * (the source is then the host name). Throws on anything else so a bad edit is loud.
 */
export function parseFeedList(value: string): FeedConfig[] {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === DEFAULT_FEEDS_SENTINEL) return [...DEFAULT_FEEDS];
  if (trimmed.startsWith('[')) return FeedListSchema.parse(JSON.parse(trimmed));
  const lines = trimmed
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);
  return FeedListSchema.parse(lines.map((url) => ({ url, source: hostOf(url) })));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
