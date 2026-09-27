import { describe, expect, it } from 'vitest';
import { decodeEntities, elementText, newsId, normalizeArticleUrl, parseFeed } from './rss.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>NFL News</title>
  <atom:link href="https://example.com/feed" rel="self" />
  <image><title>Logo</title><url>https://example.com/logo.png</url><link>https://example.com</link></image>
  <item>
    <title><![CDATA[Patrick Mahomes &amp; Chiefs roll]]></title>
    <link>https://example.com/story-1?utm_source=rss&amp;id=7</link>
    <pubDate>Sun, 07 Sep 2025 20:15:00 GMT</pubDate>
    <description>&lt;p&gt;Kansas City&amp;#39;s QB threw &lt;b&gt;three&lt;/b&gt; TDs.&lt;/p&gt;</description>
  </item>
  <item>
    <title>No link here</title>
    <description>dropped</description>
  </item>
  <item>
    <title>Guid permalink</title>
    <guid isPermaLink="true">https://example.com/story-2</guid>
    <dc:date>2025-09-07T21:00:00Z</dc:date>
  </item>
  <item>
    <title>Guid that is not a link</title>
    <guid isPermaLink="false">https://example.com/not-a-permalink</guid>
  </item>
  <item>
    <title>Bad date &#x2014; weird &unknown; entity</title>
    <link>https://example.com/story-3</link>
    <pubDate>not a date</pubDate>
    <description></description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Team feed</title>
  <entry>
    <title type="html">Bills sign a kicker</title>
    <link rel="self" href="https://example.com/api/entry/1"/>
    <link rel="alternate" type="text/html" href='https://example.com/bills-kicker'/>
    <published>2025-09-08T10:00:00-04:00</published>
    <summary>Buffalo adds depth.</summary>
  </entry>
  <entry>
    <title>Updated only</title>
    <link href="https://example.com/updated"/>
    <updated>2025-09-08T11:00:00Z</updated>
    <content type="html">${'x'.repeat(600)}</content>
  </entry>
  <entry>
    <title>Not http</title>
    <link href="mailto:someone@example.com"/>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('reads RSS items: CDATA, entity-encoded HTML, dates, and permalink guids', () => {
    expect(parseFeed(RSS)).toEqual([
      {
        title: 'Patrick Mahomes & Chiefs roll',
        url: 'https://example.com/story-1?utm_source=rss&id=7',
        publishedAt: '2025-09-07T20:15:00.000Z',
        summary: "Kansas City's QB threw three TDs."
      },
      {
        title: 'Guid permalink',
        url: 'https://example.com/story-2',
        publishedAt: '2025-09-07T21:00:00.000Z',
        summary: null
      },
      {
        title: 'Bad date — weird &unknown; entity',
        url: 'https://example.com/story-3',
        publishedAt: null,
        summary: null
      }
    ]);
  });

  it('reads Atom entries, preferring the alternate link, and truncates long summaries', () => {
    const entries = parseFeed(ATOM);
    expect(entries.map((e) => [e.title, e.url, e.publishedAt])).toEqual([
      ['Bills sign a kicker', 'https://example.com/bills-kicker', '2025-09-08T14:00:00.000Z'],
      ['Updated only', 'https://example.com/updated', '2025-09-08T11:00:00.000Z']
    ]);
    expect(entries[0]?.summary).toBe('Buffalo adds depth.');
    expect(entries[1]?.summary).toHaveLength(500);
    expect(entries[1]?.summary?.endsWith('…')).toBe(true);
  });

  it('returns nothing for a non-feed document', () => {
    expect(parseFeed('<html><body>Not a feed</body></html>')).toEqual([]);
  });
});

describe('text helpers', () => {
  it('decodes named and numeric entities and leaves bad ones alone', () => {
    expect(decodeEntities('&lt;a&gt; &quot;x&quot; &apos;y&apos; &#65;&#x42; &nbsp;&hellip;')).toBe(
      '<a> "x" \'y\' AB  …'
    );
    expect(decodeEntities('&#0; &#x110000; &bogus;')).toBe('&#0; &#x110000; &bogus;');
  });

  it('flattens element text', () => {
    expect(elementText('  <![CDATA[<p>One</p>\n<p>Two</p>]]>  ')).toBe('One Two');
  });
});

describe('article urls', () => {
  it('normalizes tracking parameters, fragments, case, scheme, and trailing slashes', () => {
    expect(normalizeArticleUrl('http://WWW.Example.com/a/b/?utm_campaign=x&b=2&a=1&fbclid=z#top')).toBe(
      'https://www.example.com/a/b/?a=1&b=2'
    );
    expect(normalizeArticleUrl('https://example.com/story/')).toBe('https://example.com/story');
    expect(() => normalizeArticleUrl('not a url')).toThrow();
  });

  it('hashes the normalized url, so syndicated copies share an id', () => {
    const a = newsId('https://example.com/story?utm_source=feed1');
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(newsId('https://example.com/story/#comments')).toBe(a);
    expect(newsId('https://example.com/other')).not.toBe(a);
  });
});
