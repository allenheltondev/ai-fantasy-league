/**
 * Typed fetch for the Fantasy API (docs/ARCHITECTURE.md "Response envelope").
 *
 * - Paths are relative to `/api/v1` and stay same-origin: CloudFront routes
 *   `/api/*` to the Lambda in the cloud, and Vite proxies it locally.
 * - Every request carries `Authorization: Bearer <id token>` when signed in.
 * - Mutations (POST/PUT/PATCH/DELETE) carry an `Idempotency-Key`, generated
 *   per call unless the caller passes one (pass the same key to retry safely).
 * - Success bodies `{ data, league, warnings }` are unwrapped into an
 *   `ApiResult`; error bodies `{ error: { code, message, fix, details } }`
 *   become an `ApiError`.
 */

export const API_PREFIX = '/api/v1';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const MUTATIONS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The league context every success response carries. */
export interface LeagueContext {
  phase: string;
  week: number;
  allowedActions: string[];
}

export interface ApiResult<T> {
  data: T;
  league: LeagueContext | null;
  warnings: unknown[];
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fix?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix: string | undefined;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.fix = body.fix;
    this.details = body.details;
  }
}

export type QueryValue = string | number | boolean | null | undefined | readonly string[];

export interface ApiRequest {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Reuse a key to make a retried mutation a replay rather than a repeat. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** A valid ID token, or null to call anonymously. */
  getToken: () => Promise<string | null>;
  /** Called on a 401 so the auth layer can drop a session the API refused. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
  newKey?: () => string;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) for (const item of value) search.append(key, String(item));
    else if (value !== undefined && value !== null) search.append(key, String(value));
  }
  const qs = search.toString();
  return `${API_PREFIX}${suffix}${qs ? `?${qs}` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorBody(status: number, statusText: string, payload: unknown): ApiErrorBody {
  if (isRecord(payload) && isRecord(payload.error)) {
    const err = payload.error;
    const body: ApiErrorBody = {
      code: typeof err.code === 'string' ? err.code : `HTTP_${status}`,
      message: typeof err.message === 'string' ? err.message : statusText || `HTTP ${status}`
    };
    if (typeof err.fix === 'string') body.fix = err.fix;
    if (err.details !== undefined) body.details = err.details;
    return body;
  }
  return { code: `HTTP_${status}`, message: statusText || `HTTP ${status}` };
}

function toLeague(value: unknown): LeagueContext | null {
  if (!isRecord(value)) return null;
  return {
    phase: typeof value.phase === 'string' ? value.phase : '',
    week: typeof value.week === 'number' ? value.week : 0,
    allowedActions: Array.isArray(value.allowedActions)
      ? value.allowedActions.filter((a): a is string => typeof a === 'string')
      : []
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const newKey = options.newKey ?? (() => crypto.randomUUID());

  return async function apiFetch<T>(path: string, request: ApiRequest = {}): Promise<ApiResult<T>> {
    const method = request.method ?? 'GET';
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await options.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (MUTATIONS.has(method)) headers['idempotency-key'] = request.idempotencyKey ?? newKey();

    const init: RequestInit = { method, headers };
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    if (request.signal) init.signal = request.signal;

    const response = await doFetch(buildUrl(path, request.query), init);
    const payload = await readJson(response);

    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      throw new ApiError(response.status, toErrorBody(response.status, response.statusText, payload));
    }
    if (!isRecord(payload) || !('data' in payload)) {
      throw new ApiError(response.status, {
        code: 'BAD_ENVELOPE',
        message: 'The API answered without a data envelope.'
      });
    }
    return {
      data: payload.data as T,
      league: toLeague(payload.league),
      warnings: Array.isArray(payload.warnings) ? payload.warnings : []
    };
  };
}

export type ApiFetch = ReturnType<typeof createApiClient>;
