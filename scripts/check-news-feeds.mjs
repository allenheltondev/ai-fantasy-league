#!/usr/bin/env node
// Checks which news RSS feeds respond and parse, from wherever the feeds are reachable (CI,
// AWS, a laptop; the dev sandbox's network policy blocks them). Writes a JSON report and prints
// a table. docs/data-sources.md records the results.
//
//   node scripts/check-news-feeds.mjs                               # the built-in default feeds
//   node scripts/check-news-feeds.mjs --feeds my-feeds.json         # a JSON array of {url, source}
//   node scripts/check-news-feeds.mjs --out /tmp/news-feeds.json
//
// Exits non-zero when no feed works at all.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_FEEDS = new URL('../packages/server/src/jobs/news/default-feeds.json', import.meta.url);
const USER_AGENT = 'ai-fantasy-league-news/1.0 (+https://fantasy.readysetcloud.io)';

/** Counts RSS <item>s and Atom <entry>s. */
export function countEntries(xml) {
  return (xml.match(/<(item|entry)\b[^>]*>/gi) ?? []).length;
}

/** Fetches every feed once and reports status, content type, and entry count. */
export async function checkFeeds(feeds, fetchImpl = fetch, timeoutMs = 15_000) {
  const results = [];
  for (const feed of feeds) {
    const started = Date.now();
    try {
      const res = await fetchImpl(feed.url, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/rss+xml, application/atom+xml, application/xml, */*'
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow'
      });
      const body = await res.text();
      const entries = countEntries(body);
      results.push({
        source: feed.source,
        url: feed.url,
        status: res.status,
        contentType: res.headers.get('content-type'),
        entries,
        ok: res.ok && entries > 0,
        ms: Date.now() - started
      });
    } catch (error) {
      results.push({
        source: feed.source,
        url: feed.url,
        status: null,
        entries: 0,
        ok: false,
        error: String(error)
      });
    }
  }
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      feeds: { type: 'string' },
      out: { type: 'string', default: 'news-feeds-report.json' }
    }
  });
  const source = values.feeds ? resolve(values.feeds) : DEFAULT_FEEDS;
  const feeds = JSON.parse(readFileSync(source, 'utf8'));
  const results = await checkFeeds(feeds);
  const report = { checkedAt: new Date().toISOString(), results };
  writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + '\n');
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    process.stdout.write(
      `${mark} ${String(r.status ?? '-').padEnd(4)} ${String(r.entries).padStart(3)} items  ${r.source}  ${r.url}${r.error ? `  (${r.error})` : ''}\n`
    );
  }
  if (!results.some((r) => r.ok)) {
    process.stderr.write('check-news-feeds: no feed returned any items\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
