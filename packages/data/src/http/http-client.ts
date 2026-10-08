import { DataSourceError, HttpStatusError, RequestTimeoutError } from '../errors.js';
import { timerSleep, type RateLimiter, type Sleep } from './rate-limiter.js';

/** The subset of `fetch` we use, so tests can inject a mock. */
export type FetchLike = (
  input: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<Response>;

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 30_000 };

export interface HttpClientOptions {
  fetch?: FetchLike;
  limiter?: RateLimiter;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  sleep?: Sleep;
  /** Source of jitter in [0, 1). Injected so tests are deterministic. */
  random?: () => number;
  headers?: Record<string, string>;
}

export interface RequestOptions {
  timeoutMs?: number;
}

/**
 * Exponential backoff with "equal jitter": half the exponential delay is fixed, the other half is
 * random, so delays grow but concurrent clients do not retry in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** Parses a `Retry-After` header given in seconds. HTTP-date values are ignored (no clock here). */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return undefined;
  return Math.round(Number(value) * 1000);
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** GET-only HTTP client with rate limiting, timeouts, and retries on 408/429/5xx and network errors. */
export class HttpClient {
  readonly #fetch: FetchLike;
  readonly #limiter: RateLimiter | undefined;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #headers: Record<string, string>;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetch ?? defaultFetch;
    this.#limiter = options.limiter;
    this.#retry = { ...DEFAULT_RETRY, ...options.retry };
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#sleep = options.sleep ?? timerSleep;
    this.#random = options.random ?? Math.random;
    this.#headers = { accept: 'application/json, text/csv;q=0.9, */*;q=0.5', ...options.headers };
  }

  getText(url: string, options: RequestOptions = {}): Promise<string> {
    return this.#get(url, options, (res) => res.text());
  }

  /** The raw body, for binary files (such as a gzipped CSV). */
  async getBytes(url: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return new Uint8Array(await this.#get(url, options, (res) => res.arrayBuffer()));
  }

  async #get<T>(url: string, options: RequestOptions, read: (res: Response) => Promise<T>): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.#retry.maxRetries;
      if (this.#limiter) await this.#limiter.acquire();
      let outcome: { ok: true; body: T } | { ok: false; status: number; retryAfter: string | null };
      try {
        outcome = await this.#attempt(url, timeoutMs, read);
      } catch (error) {
        if (!canRetry) throw error;
        await this.#sleep(backoffDelay(attempt, this.#retry, this.#random));
        continue;
      }
      if (outcome.ok) return outcome.body;
      if (!canRetry || !isRetryableStatus(outcome.status)) throw new HttpStatusError(url, outcome.status);
      const hinted = outcome.status === 429 ? parseRetryAfter(outcome.retryAfter) : undefined;
      const delay =
        hinted !== undefined
          ? Math.min(hinted, this.#retry.maxDelayMs)
          : backoffDelay(attempt, this.#retry, this.#random);
      await this.#sleep(delay);
    }
  }

  async getJson(url: string, options: RequestOptions = {}): Promise<unknown> {
    const text = await this.getText(url, options);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new DataSourceError(`GET ${url} returned invalid JSON`, { cause: error });
    }
  }

  async #attempt<T>(
    url: string,
    timeoutMs: number,
    read: (res: Response) => Promise<T>
  ): Promise<{ ok: true; body: T } | { ok: false; status: number; retryAfter: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.#fetch(url, { signal: controller.signal, headers: this.#headers });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, retryAfter: res.headers.get('retry-after') };
      }
      return { ok: true, body: await read(res) };
    } catch (error) {
      if (controller.signal.aborted) throw new RequestTimeoutError(url, timeoutMs);
      throw new DataSourceError(`GET ${url} failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
