// Run with: npm run test:scripts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkFeeds, countEntries } from './check-news-feeds.mjs';

describe('countEntries', () => {
  it('counts RSS items and Atom entries', () => {
    assert.equal(countEntries('<rss><channel><item></item><item/></channel></rss>'), 2);
    assert.equal(countEntries('<feed><entry xml:lang="en"></entry></feed>'), 1);
    assert.equal(countEntries('<html></html>'), 0);
  });
});

describe('checkFeeds', () => {
  it('reports working, empty, failing, and unreachable feeds', async () => {
    const bodies = {
      'https://a.example/rss': [200, '<rss><item></item></rss>'],
      'https://b.example/rss': [200, '<html>blocked</html>'],
      'https://c.example/rss': [503, '']
    };
    const fetchImpl = async (url) => {
      const entry = bodies[url];
      if (!entry) throw new Error('ENOTFOUND');
      return new Response(entry[1], { status: entry[0], headers: { 'content-type': 'application/rss+xml' } });
    };
    const results = await checkFeeds(
      ['a', 'b', 'c', 'd'].map((x) => ({ source: x, url: `https://${x}.example/rss` })),
      fetchImpl
    );
    assert.deepEqual(
      results.map((r) => [r.source, r.status, r.entries, r.ok]),
      [
        ['a', 200, 1, true],
        ['b', 200, 0, false],
        ['c', 503, 0, false],
        ['d', null, 0, false]
      ]
    );
    assert.match(results[3].error, /ENOTFOUND/);
  });
});
