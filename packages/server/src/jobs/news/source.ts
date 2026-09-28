import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { HttpClient, type FetchLike } from '@fantasy/data';
import type { Logger } from '../../log.js';
import type { NewsSource } from '../deps.js';
import { DEFAULT_FEEDS, parseFeedList, type FeedConfig } from './feeds.js';

/** The part of the SSM client we use, so tests can pass a fake. */
export interface ParameterReader {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string | undefined } | undefined }>;
}

export interface NewsSourceOptions {
  /** SSM parameter with the feed list. Read on every run, so edits apply without a deploy. */
  parameterName?: string | undefined;
  ssm?: ParameterReader;
  /** Inline list (`NEWS_FEEDS`), used when there is no parameter. */
  inline?: string | undefined;
  fetch?: FetchLike;
  log: Logger;
}

/** Identifies us to publishers; some feeds reject requests without a user agent. */
export const NEWS_USER_AGENT = 'ai-fantasy-league-news/1.0 (+https://fantasy.readysetcloud.io)';

export function createNewsSource(options: NewsSourceOptions): NewsSource {
  const http = new HttpClient({
    timeoutMs: 10_000,
    retry: { maxRetries: 1, baseDelayMs: 500 },
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
      'user-agent': NEWS_USER_AGENT
    },
    ...(options.fetch && { fetch: options.fetch })
  });
  return {
    fetchText: (url) => http.getText(url),
    feeds: () => loadFeeds(options)
  };
}

async function loadFeeds(options: NewsSourceOptions): Promise<FeedConfig[]> {
  try {
    if (options.parameterName !== undefined && options.ssm !== undefined) {
      const result = await options.ssm.send(new GetParameterCommand({ Name: options.parameterName }));
      return parseFeedList(result.Parameter?.Value ?? '');
    }
    if (options.inline !== undefined) return parseFeedList(options.inline);
  } catch (error) {
    options.log.error('news feed list is unreadable; using the built-in defaults', {
      error,
      parameter: options.parameterName
    });
  }
  return [...DEFAULT_FEEDS];
}
