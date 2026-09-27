import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { createTestJobDeps } from '../../test/support/jobs.js';
import { fixturePlayers } from '../players/fixtures.js';
import { ingestNews } from './ingest-news.js';
import { newsId } from './news/rss.js';

const NOW = '2025-09-10T12:00:00.000Z';

function rss(items: { title: string; link: string; date?: string; description?: string }[]): string {
  const body = items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link>${i.date ? `<pubDate>${i.date}</pubDate>` : ''}${
          i.description ? `<description>${i.description}</description>` : ''
        }</item>`
    )
    .join('');
  return `<rss version="2.0"><channel><title>t</title>${body}</channel></rss>`;
}

async function setup() {
  const deps = createTestJobDeps({ clock: new FixedClock(NOW) });
  await deps.playerRepo.putMany(fixturePlayers);
  deps.news.list = [
    { url: 'https://a.example/rss', source: 'Outlet A' },
    { url: 'https://b.example/rss', source: 'Outlet B' },
    { url: 'https://team.example/rss', source: 'Bills', team: 'BUF' }
  ];
  deps.news.bodies.set(
    'https://a.example/rss',
    rss([
      {
        title: 'Christian McCaffrey limited at practice',
        link: 'https://news.example/cmc?utm_source=a',
        date: 'Wed, 10 Sep 2025 09:00:00 GMT',
        description: 'The 49ers back is day to day.'
      },
      {
        title: 'League announces new kickoff rule',
        link: 'https://news.example/rule',
        date: 'Wed, 10 Sep 2025 08:00:00 GMT'
      },
      {
        title: 'Old news about Travis Kelce',
        link: 'https://news.example/old',
        date: 'Fri, 05 Sep 2025 08:00:00 GMT'
      }
    ])
  );
  deps.news.bodies.set(
    'https://b.example/rss',
    rss([
      // The same story syndicated with different tracking parameters.
      {
        title: 'McCaffrey limited (syndicated)',
        link: 'https://news.example/cmc?utm_source=b',
        date: 'Wed, 10 Sep 2025 09:05:00 GMT'
      },
      { title: 'Chiefs extend Travis Kelce', link: 'https://news.example/kelce' }
    ])
  );
  deps.news.bodies.set('https://team.example/rss', new Error('HTTP 503'));
  return deps;
}

describe('ingestNews', () => {
  it('stores new items tagged to players and teams and alerts only for player items', async () => {
    const deps = await setup();
    const result = await ingestNews(deps, deps.clock);

    expect(result).toMatchObject({ status: 'ok', feeds: 3, failedFeeds: 1, added: 3 });
    expect(result.outcomes).toEqual([
      { source: 'Outlet A', url: 'https://a.example/rss', ok: true, entries: 3, added: 2 },
      { source: 'Outlet B', url: 'https://b.example/rss', ok: true, entries: 2, added: 1 },
      { source: 'Bills', url: 'https://team.example/rss', ok: false, entries: 0, added: 0, error: 'HTTP 503' }
    ]);

    const recent = await deps.reference.news.listRecent({ limit: 10 });
    expect(recent.map((i) => [i.title, i.playerIds, i.teams, i.publishedAt])).toEqual([
      ['Chiefs extend Travis Kelce', ['fx-kelce'], ['KC'], NOW],
      ['Christian McCaffrey limited at practice', ['fx-cmc'], ['SF'], '2025-09-10T09:00:00.000Z'],
      ['League announces new kickoff rule', [], [], '2025-09-10T08:00:00.000Z']
    ]);
    expect(recent[1]).toMatchObject({
      id: newsId('https://news.example/cmc'),
      url: 'https://news.example/cmc',
      source: 'Outlet A',
      summary: 'The 49ers back is day to day.',
      ingestedAt: NOW
    });

    expect(deps.events.events.map((e) => [e.detailType, e.detail.playerIds])).toEqual([
      ['Player News Alert', ['fx-cmc']],
      ['Player News Alert', ['fx-kelce']]
    ]);
    expect(deps.events.events[0]?.detail).toEqual({
      newsId: newsId('https://news.example/cmc'),
      title: 'Christian McCaffrey limited at practice',
      url: 'https://news.example/cmc',
      source: 'Outlet A',
      publishedAt: '2025-09-10T09:00:00.000Z',
      playerIds: ['fx-cmc'],
      teams: ['SF']
    });
  });

  it('dedupes across runs, so a repeated poll adds and alerts nothing', async () => {
    const deps = await setup();
    await ingestNews(deps, deps.clock);
    deps.clock.advance(15 * 60_000);
    const again = await ingestNews(deps, deps.clock);
    expect(again).toMatchObject({ added: 0 });
    expect(deps.events.events).toHaveLength(2);
  });

  it('tags a team feed’s items to its team and uses it to resolve shared names', async () => {
    const deps = await setup();
    deps.news.list = [{ url: 'https://team.example/rss', source: 'Bills', team: 'BUF' }];
    deps.news.bodies.set(
      'https://team.example/rss',
      rss([
        { title: 'Josh Allen named captain', link: 'https://bills.example/captain' },
        { title: 'Future item', link: 'https://bills.example/future', date: 'Thu, 11 Sep 2025 12:00:00 GMT' },
        { title: 'Bad link', link: 'https://bad host/x' }
      ])
    );
    await ingestNews(deps, deps.clock);
    const items = await deps.reference.news.listByTeam('BUF', { limit: 10 });
    expect(items.map((i) => [i.title, i.playerIds, i.publishedAt]).sort()).toEqual([
      // Clock skew: a publish time in the future is clamped to now.
      ['Future item', [], NOW],
      ['Josh Allen named captain', ['fx-jallen'], NOW]
    ]);
  });
});
