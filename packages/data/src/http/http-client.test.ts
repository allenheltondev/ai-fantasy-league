import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, mockFetch, text } from '../../test/helpers.js';
import { DataSourceError, HttpStatusError, RequestTimeoutError } from '../errors.js';
import {
  DEFAULT_RETRY,
  HttpClient,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  type FetchLike
} from './http-client.js';
import type { RateLimiter } from './rate-limiter.js';

const URL_ = 'https://example.test/x';

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

describe('backoffDelay', () => {
  const policy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 1000 };

  it('grows exponentially with equal jitter', () => {
    expect(backoffDelay(0, policy, () => 0)).toBe(50);
    expect(backoffDelay(0, policy, () => 0.999999)).toBe(100);
    expect(backoffDelay(1, policy, () => 0)).toBe(100);
    expect(backoffDelay(2, policy, () => 0.5)).toBe(300);
  });

  it('caps at maxDelayMs', () => {
    expect(backoffDelay(10, policy, () => 0.999999)).toBe(1000);
    expect(backoffDelay(10, policy, () => 0)).toBe(500);
  });
});

describe('isRetryableStatus / parseRetryAfter', () => {
  it('retries 408, 429, and 5xx only', () => {
    expect([408, 429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });

  it('parses delta-seconds and ignores dates and junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(' 1.5 ')).toBe(1500);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
  });
});

describe('HttpClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the body on success and sends an accept header', async () => {
    let headers: Record<string, string> = {};
    const fetch: FetchLike = async (_url, init) => {
      headers = init.headers;
      return text('ok');
    };
    const client = new HttpClient({ fetch, headers: { 'user-agent': 'fantasy-test' } });
    expect(await client.getText(URL_)).toBe('ok');
    expect(headers.accept).toContain('application/json');
    expect(headers['user-agent']).toBe('fantasy-test');
  });

  it('returns the raw bytes for binary files, with the same retries', async () => {
    const m = mockFetch((_u, call) =>
      call === 1 ? text('busy', 503) : new Response(new Uint8Array([31, 139, 8]))
    );
    const client = new HttpClient({ fetch: m.fetch, sleep: async () => undefined, random: () => 0 });
    expect(await client.getBytes(URL_)).toEqual(new Uint8Array([31, 139, 8]));
    expect(m.calls).toHaveLength(2);
  });

  it('retries 5xx and 429 with backoff, then succeeds', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch((_u, call) =>
      call === 1 ? text('boom', 503) : call === 2 ? text('slow', 429) : json({ a: 1 })
    );
    const client = new HttpClient({ fetch: m.fetch, sleep, random: () => 0 });
    expect(await client.getJson(URL_)).toEqual({ a: 1 });
    expect(m.calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
  });

  it('honors Retry-After on 429, capped at maxDelayMs', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch((_u, call) =>
      call === 1
        ? json({}, 429, { 'retry-after': '2' })
        : call === 2
          ? json({}, 429, { 'retry-after': '120' })
          : json([])
    );
    const client = new HttpClient({ fetch: m.fetch, sleep, random: () => 0 });
    await client.getJson(URL_);
    expect(delays).toEqual([2000, DEFAULT_RETRY.maxDelayMs]);
  });

  it('does not retry 4xx', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(() => text('nope', 404));
    const client = new HttpClient({ fetch: m.fetch, sleep });
    const error = await client.getText(URL_).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(404);
    expect(m.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('gives up after maxRetries and surfaces the last status', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(() => text('down', 500));
    const client = new HttpClient({ fetch: m.fetch, sleep, random: () => 0, retry: { maxRetries: 2 } });
    await expect(client.getText(URL_)).rejects.toMatchObject({ name: 'HttpStatusError', status: 500 });
    expect(m.calls).toHaveLength(3);
    expect(delays).toHaveLength(2);
  });

  it('retries network errors and rethrows them wrapped when retries run out', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    const client = new HttpClient({ fetch, sleep, retry: { maxRetries: 1 } });
    const error = await client.getText(URL_).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataSourceError);
    expect((error as Error).message).toContain('fetch failed');
    expect(calls).toBe(2);
  });

  it('times out slow requests and retries them', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch: FetchLike = (_url, init) => {
      calls++;
      if (calls === 2) return Promise.resolve(text('finally'));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const client = new HttpClient({ fetch, timeoutMs: 1000, random: () => 0 });
    const result = client.getText(URL_);
    await vi.advanceTimersByTimeAsync(1000); // timeout
    await vi.advanceTimersByTimeAsync(250); // backoff
    expect(await result).toBe('finally');
    expect(calls).toBe(2);
  });

  it('raises RequestTimeoutError when every attempt times out', async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new HttpClient({ fetch, timeoutMs: 500, retry: { maxRetries: 0 } });
    const result = client.getText(URL_).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    const error = await result;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ url: URL_, timeoutMs: 500 });
  });

  it('per-request timeout overrides the default', async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = (_url, init) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(text('late')), 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    const client = new HttpClient({ fetch, timeoutMs: 1000, retry: { maxRetries: 0 } });
    const result = client.getText(URL_, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('late');
  });

  it('acquires a rate-limit token before every attempt, including retries', async () => {
    let acquired = 0;
    const limiter: RateLimiter = { acquire: async () => void acquired++ };
    const m = mockFetch((_u, call) => (call < 3 ? text('', 502) : text('ok')));
    const client = new HttpClient({ fetch: m.fetch, limiter, sleep: async () => undefined });
    await client.getText(URL_);
    expect(acquired).toBe(3);
  });

  it('raises DataSourceError on invalid JSON', async () => {
    const client = new HttpClient({ fetch: async () => text('<html>') });
    await expect(client.getJson(URL_)).rejects.toThrow(/invalid JSON/);
  });
});
