import type { Harness } from './harness.js';
import { signIdToken } from './tokens.js';

export interface Person {
  sub: string;
  name: string;
  email: string;
}

type Response = Awaited<ReturnType<Harness['request']>>;

export interface Caller {
  token: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, idempotencyKey?: string): Promise<Response>;
  put(path: string, body?: unknown, idempotencyKey?: string): Promise<Response>;
  patch(path: string, body?: unknown, idempotencyKey?: string): Promise<Response>;
  del(path: string, idempotencyKey?: string): Promise<Response>;
}

let counter = 0;
const nextKey = () => `test-key-${++counter}-${Math.random().toString(36).slice(2, 10)}`;

/** Calls the REST API as a signed-in person. Paths are relative to /api/v1; mutations get a fresh key. */
export function as(h: Harness, person: Person): Caller {
  const token = signIdToken({ sub: person.sub, name: person.name, email: person.email });
  const send = (method: string, path: string, body: unknown, idempotencyKey: string | undefined) =>
    h.request(`/api/v1${path}`, {
      method,
      token,
      ...(body === undefined ? {} : { body }),
      idempotencyKey: idempotencyKey ?? nextKey()
    });
  return {
    token,
    get: (path) => h.request(`/api/v1${path}`, { token }),
    post: (path, body, key) => send('POST', path, body ?? {}, key),
    put: (path, body, key) => send('PUT', path, body ?? {}, key),
    patch: (path, body, key) => send('PATCH', path, body ?? {}, key),
    del: (path, key) => send('DELETE', path, undefined, key)
  };
}

/** `body.data` of a success response, typed loosely for assertions. */
export function data<T = Record<string, unknown>>(res: Response): T {
  return (res.body as { data: T }).data;
}

export function errorCode(res: Response): string | undefined {
  return (res.body as { error?: { code: string } }).error?.code;
}
