import { describe, expect, it, vi } from 'vitest';
import { ApiError, buildUrl, createApiClient } from './client';

function jsonResponse(body: unknown, status = 200, statusText = '') {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' }
  });
}

function setup(response: Response | (() => Response), token: string | null = 'id-token') {
  const fetchImpl = vi.fn(async () => (typeof response === 'function' ? response() : response));
  const onUnauthorized = vi.fn();
  const api = createApiClient({
    getToken: async () => token,
    onUnauthorized,
    fetch: fetchImpl as unknown as typeof fetch,
    newKey: () => 'generated-key'
  });
  const lastInit = () => {
    const call = fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit];
    return { url: call[0], init: call[1], headers: call[1].headers as Record<string, string> };
  };
  return { api, fetchImpl, onUnauthorized, lastInit };
}

const envelope = {
  data: { id: 'L1' },
  league: { phase: 'waivers_open', week: 5, allowedActions: ['claim_waiver', 7] },
  warnings: ['heads up']
};

describe('buildUrl', () => {
  it('prefixes /api/v1 and drops empty query values', () => {
    expect(buildUrl('leagues', { a: 1, b: null, c: undefined, d: true })).toBe('/api/v1/leagues?a=1&d=true');
    expect(buildUrl('/health')).toBe('/api/v1/health');
  });

  it('repeats a key for each value of an array', () => {
    expect(buildUrl('/t', { send: ['a', 'b'], none: [] })).toBe('/api/v1/t?send=a&send=b');
  });
});

describe('apiFetch', () => {
  it('sends the bearer token and unwraps the envelope on a GET', async () => {
    const { api, lastInit } = setup(jsonResponse(envelope));
    const result = await api<{ id: string }>('/leagues/L1');
    expect(result).toEqual({
      data: { id: 'L1' },
      league: { phase: 'waivers_open', week: 5, allowedActions: ['claim_waiver'] },
      warnings: ['heads up']
    });
    const { url, init, headers } = lastInit();
    expect(url).toBe('/api/v1/leagues/L1');
    expect(init.method).toBe('GET');
    expect(headers.authorization).toBe('Bearer id-token');
    expect(headers['idempotency-key']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('omits Authorization when signed out', async () => {
    const { api, lastInit } = setup(jsonResponse({ data: null }), null);
    await api('/health');
    expect(lastInit().headers.authorization).toBeUndefined();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('adds an Idempotency-Key to %s', async (method) => {
    const { api, lastInit } = setup(jsonResponse({ data: {} }));
    await api('/x', { method, body: { a: 1 } });
    const { init, headers } = lastInit();
    expect(headers['idempotency-key']).toBe('generated-key');
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('reuses a caller-supplied idempotency key and forwards the signal', async () => {
    const { api, lastInit } = setup(jsonResponse({ data: {} }));
    const controller = new AbortController();
    await api('/x', { method: 'POST', idempotencyKey: 'retry-1', signal: controller.signal });
    expect(lastInit().headers['idempotency-key']).toBe('retry-1');
    expect(lastInit().init.signal).toBe(controller.signal);
  });

  it('defaults league and warnings when absent', async () => {
    const { api } = setup(jsonResponse({ data: [1, 2], league: { phase: 3 } }));
    await expect(api('/x')).resolves.toEqual({
      data: [1, 2],
      league: { phase: '', week: 0, allowedActions: [] },
      warnings: []
    });
  });

  it('throws an ApiError from the error envelope, with fix and details', async () => {
    const { api } = setup(
      jsonResponse(
        {
          error: {
            code: 'ROSTER_FULL',
            message: 'Roster full (15/15).',
            fix: 'Drop someone.',
            details: { n: 15 }
          }
        },
        409
      )
    );
    const error = await api('/x', { method: 'POST' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'ROSTER_FULL',
      message: 'Roster full (15/15).',
      fix: 'Drop someone.',
      details: { n: 15 }
    });
  });

  it('falls back to the status when the error body is not an envelope', async () => {
    const { api } = setup(
      () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })
    );
    await expect(api('/x')).rejects.toMatchObject({ code: 'HTTP_502', message: 'Bad Gateway' });
    const partial = setup(jsonResponse({ error: {} }, 500));
    await expect(partial.api('/x')).rejects.toMatchObject({ code: 'HTTP_500', message: 'HTTP 500' });
    const empty = setup(jsonResponse(undefined, 503));
    await expect(empty.api('/x')).rejects.toMatchObject({ code: 'HTTP_503', message: 'HTTP 503' });
  });

  it('calls onUnauthorized on a 401', async () => {
    const { api, onUnauthorized } = setup(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Sign in.' } }, 401)
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('rejects a 2xx without a data envelope', async () => {
    const { api } = setup(jsonResponse({ ok: true }));
    await expect(api('/x')).rejects.toMatchObject({ code: 'BAD_ENVELOPE' });
  });

  it('uses the global fetch and crypto.randomUUID by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: 1 }));
    const api = createApiClient({ getToken: async () => null });
    await api('/x', { method: 'POST' });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    spy.mockRestore();
  });
});
