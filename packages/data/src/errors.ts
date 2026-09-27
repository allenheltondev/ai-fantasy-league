/** Base class for every error raised by `@fantasy/data`. */
export class DataSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface DriftIssue {
  path: string;
  message: string;
}

/**
 * The upstream response no longer matches the shape we validated against. Alert on this: it
 * usually means Sleeper or nflverse changed a payload.
 */
export class SchemaDriftError extends DataSourceError {
  readonly source: string;
  readonly issues: DriftIssue[];

  constructor(source: string, issues: DriftIssue[]) {
    const shown = issues
      .slice(0, 5)
      .map((i) => `${i.path || '<root>'}: ${i.message}`)
      .join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(`Schema drift in ${source}: ${shown}${more}`);
    this.source = source;
    this.issues = issues;
  }
}

/** Non-retryable (or retries exhausted) HTTP status. */
export class HttpStatusError extends DataSourceError {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number) {
    super(`GET ${url} failed with HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

export class RequestTimeoutError extends DataSourceError {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`GET ${url} timed out after ${timeoutMs}ms`);
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** The requested data does not exist yet at the caller's `asOf`, or was never captured. */
export class DataNotAvailableError extends DataSourceError {}
