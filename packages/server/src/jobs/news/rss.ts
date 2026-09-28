import { createHash } from 'node:crypto';

/**
 * A small, dependency-free reader for RSS 2.0 and Atom feeds. It only needs what news ingestion
 * stores (title, link, publish time, and a plain-text description), and tolerates the usual
 * real-world mess: CDATA, HTML inside descriptions, entities, and namespaced elements.
 */

export interface FeedEntry {
  title: string;
  url: string;
  /** ISO 8601, or null when the feed gave no parseable date. */
  publishedAt: string | null;
  summary: string | null;
}

const MAX_SUMMARY = 500;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…'
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X'))
      return safeCodePoint(parseInt(code.slice(2), 16), match);
    if (code.startsWith('#')) return safeCodePoint(parseInt(code.slice(1), 10), match);
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function safeCodePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/** Element text: CDATA unwrapped, entities decoded, HTML tags dropped, whitespace collapsed. */
export function elementText(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Entity-encoded HTML (common in descriptions) is decoded first, then its tags are dropped.
  const decoded = decodeEntities(unwrapped);
  return decodeEntities(decoded.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstElement(block: string, names: readonly string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i').exec(block);
    if (match?.[1] !== undefined) {
      const text = elementText(match[1]);
      if (text.length > 0) return text;
    }
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (match === null) return null;
  return decodeEntities(match[2] ?? match[3] ?? '');
}

/** Atom `<link href>` (preferring rel="alternate"), else RSS `<link>text</link>`, else a permalink guid. */
function entryLink(block: string): string | null {
  const atomLinks = [...block.matchAll(/<link\b[^>]*\/?>/gi)].map((m) => m[0]);
  const hrefs = atomLinks
    .map((tag) => ({ href: attribute(tag, 'href'), rel: attribute(tag, 'rel') }))
    .filter((l): l is { href: string; rel: string | null } => l.href !== null && l.href.length > 0);
  const alternate = hrefs.find((l) => l.rel === null || l.rel === 'alternate');
  if (alternate !== undefined) return alternate.href;
  const rssLink = firstElement(block, ['link']);
  if (rssLink !== null) return rssLink;
  const guid = /<guid(\s[^>]*)?>([\s\S]*?)<\/guid>/i.exec(block);
  if (guid !== null && attribute(guid[1] ?? '', 'isPermaLink') !== 'false') {
    const text = elementText(guid[2] ?? '');
    if (/^https?:\/\//i.test(text)) return text;
  }
  return null;
}

function parseDate(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function truncate(text: string | null): string | null {
  if (text === null || text.length === 0) return null;
  return text.length <= MAX_SUMMARY ? text : `${text.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/** Parses RSS `<item>`s or Atom `<entry>`s. Entries without a title or an http(s) link are dropped. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2] ?? '');
  const entries: FeedEntry[] = [];
  for (const block of blocks) {
    const title = firstElement(block, ['title']);
    const url = entryLink(block);
    if (title === null || url === null || !/^https?:\/\//i.test(url)) continue;
    entries.push({
      title,
      url,
      publishedAt: parseDate(firstElement(block, ['pubDate', 'published', 'updated', 'dc:date'])),
      summary: truncate(firstElement(block, ['description', 'summary', 'content']))
    });
  }
  return entries;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|cmpid|ocid|ref|src|xid|partner)$/i;

/**
 * The article URL used for dedupe: lowercase host, no fragment, no tracking parameters, and no
 * trailing slash, so the same story syndicated with different campaign tags hashes the same.
 */
export function normalizeArticleUrl(url: string): string {
  const parsed = new URL(url);
  // Feeds are external input and these URLs are later rendered as links, so only web URLs are
  // accepted: javascript:, data:, file: and the like are rejected (the caller skips the entry).
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported article URL scheme: ${parsed.protocol}`);
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  const out = parsed.toString();
  return out.endsWith('/') && parsed.search === '' ? out.slice(0, -1) : out;
}

/** The news item id: a hash of the normalized URL. */
export function newsId(url: string): string {
  return createHash('sha256').update(normalizeArticleUrl(url)).digest('hex').slice(0, 24);
}
