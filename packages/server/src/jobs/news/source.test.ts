import type { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../log.js';
import { DEFAULT_FEEDS, parseFeedList } from './feeds.js';
import { createNewsSource, NEWS_USER_AGENT, type ParameterReader } from './source.js';

const logs: string[] = [];
const log = createLogger({ sink: (line) => logs.push(line) });

class FakeSsm implements ParameterReader {
  readonly names: (string | undefined)[] = [];
  constructor(private readonly value: string | Error | undefined) {}
  async send(command: GetParameterCommand) {
    this.names.push(command.input.Name);
    if (this.value instanceof Error) throw this.value;
    return { Parameter: { Value: this.value } };
  }
}

describe('parseFeedList', () => {
  it('accepts the defaults sentinel, JSON, and plain URL lists', () => {
    expect(parseFeedList('defaults')).toEqual(DEFAULT_FEEDS);
    expect(parseFeedList('  ')).toEqual(DEFAULT_FEEDS);
    expect(parseFeedList('[{"url":"https://a.example/rss","source":"A","team":"KC"}]')).toEqual([
      { url: 'https://a.example/rss', source: 'A', team: 'KC' }
    ]);
    expect(parseFeedList('https://www.b.example/feed\nhttps://c.example/rss, ')).toEqual([
      { url: 'https://www.b.example/feed', source: 'b.example' },
      { url: 'https://c.example/rss', source: 'c.example' }
    ]);
  });

  it('rejects bad entries loudly', () => {
    expect(() => parseFeedList('[]')).toThrow();
    expect(() => parseFeedList('[{"url":"ftp://x.example","source":"X"}]')).toThrow();
    expect(() => parseFeedList('[{"url":"https://x.example","source":"X","team":"ZZZ"}]')).toThrow();
    expect(() => parseFeedList('not-a-url')).toThrow();
  });

  it('ships a non-empty default list of https feeds', () => {
    expect(DEFAULT_FEEDS.length).toBeGreaterThan(3);
    for (const feed of DEFAULT_FEEDS) expect(feed.url).toMatch(/^https:\/\//);
  });
});

describe('createNewsSource', () => {
  it('reads the feed list from SSM on every call', async () => {
    const ssm = new FakeSsm('https://a.example/rss');
    const source = createNewsSource({ parameterName: '/fantasy/news-feeds', ssm, log });
    expect(await source.feeds()).toEqual([{ url: 'https://a.example/rss', source: 'a.example' }]);
    await source.feeds();
    expect(ssm.names).toEqual(['/fantasy/news-feeds', '/fantasy/news-feeds']);
  });

  it('treats an empty parameter as the defaults', async () => {
    const source = createNewsSource({ parameterName: '/p', ssm: new FakeSsm(undefined), log });
    expect(await source.feeds()).toEqual(DEFAULT_FEEDS);
  });

  it('uses the inline list without a parameter, and the defaults with neither', async () => {
    expect(await createNewsSource({ inline: 'https://i.example/rss', log }).feeds()).toEqual([
      { url: 'https://i.example/rss', source: 'i.example' }
    ]);
    expect(await createNewsSource({ log }).feeds()).toEqual(DEFAULT_FEEDS);
  });

  it('falls back to the defaults and logs when the list is unreadable', async () => {
    logs.length = 0;
    const denied = createNewsSource({
      parameterName: '/p',
      ssm: new FakeSsm(new Error('AccessDenied')),
      log
    });
    expect(await denied.feeds()).toEqual(DEFAULT_FEEDS);
    const garbled = createNewsSource({ parameterName: '/p', ssm: new FakeSsm('[{"nope":1}]'), log });
    expect(await garbled.feeds()).toEqual(DEFAULT_FEEDS);
    expect(logs.filter((l) => l.includes('unreadable'))).toHaveLength(2);
  });

  it('fetches feeds with a user agent', async () => {
    const seen: Record<string, string>[] = [];
    const source = createNewsSource({
      log,
      fetch: async (_url, init) => {
        seen.push(init.headers);
        return new Response('<rss/>');
      }
    });
    expect(await source.fetchText('https://a.example/rss')).toBe('<rss/>');
    expect(seen[0]?.['user-agent']).toBe(NEWS_USER_AGENT);
  });
});
