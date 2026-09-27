import { describe, expect, it, vi } from 'vitest';
import { configFromEnv, loadRuntimeConfig, parseRuntimeConfig, RUNTIME_CONFIG_PATH } from './runtimeConfig';

const good = { region: 'us-east-1', userPoolId: 'us-east-1_abc', clientId: 'client123' };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('parseRuntimeConfig', () => {
  it('accepts a complete document and trims values', () => {
    expect(parseRuntimeConfig({ region: ' us-east-1 ', clientId: ' c ', userPoolId: ' p ' })).toEqual({
      region: 'us-east-1',
      clientId: 'c',
      userPoolId: 'p'
    });
  });

  it('treats userPoolId as optional', () => {
    expect(parseRuntimeConfig({ region: 'us-east-1', clientId: 'c' })).toEqual({
      region: 'us-east-1',
      clientId: 'c'
    });
  });

  it.each([null, 'nope', 42, {}, { region: 'us-east-1' }, { clientId: 'c' }, { region: '', clientId: 'c' }])(
    'rejects %j',
    (raw) => {
      expect(parseRuntimeConfig(raw)).toBeNull();
    }
  );
});

describe('configFromEnv', () => {
  it('reads VITE_COGNITO_* variables', () => {
    expect(
      configFromEnv({
        VITE_COGNITO_REGION: 'us-east-1',
        VITE_COGNITO_CLIENT_ID: 'env-client',
        VITE_COGNITO_USER_POOL_ID: 'pool'
      })
    ).toEqual({ region: 'us-east-1', clientId: 'env-client', userPoolId: 'pool' });
  });

  it('is null when unset', () => {
    expect(configFromEnv({})).toBeNull();
  });
});

describe('loadRuntimeConfig', () => {
  it('fetches /auth-config.json without caching', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(good));
    await expect(loadRuntimeConfig(fetchImpl, {})).resolves.toEqual(good);
    expect(fetchImpl).toHaveBeenCalledWith(
      RUNTIME_CONFIG_PATH,
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('ignores an HTML fallback page and uses the env', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }));
    await expect(
      loadRuntimeConfig(fetchImpl, { VITE_COGNITO_REGION: 'us-east-1', VITE_COGNITO_CLIENT_ID: 'x' })
    ).resolves.toEqual({ region: 'us-east-1', clientId: 'x' });
  });

  it('ignores a 404 and an invalid document', async () => {
    const notFound = vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 }));
    await expect(loadRuntimeConfig(notFound, {})).resolves.toBeNull();
    const invalid = vi.fn().mockResolvedValue(jsonResponse({ region: 'us-east-1' }));
    await expect(loadRuntimeConfig(invalid, {})).resolves.toBeNull();
  });

  it('survives a network failure', async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(loadRuntimeConfig(offline, {})).resolves.toBeNull();
  });

  it('survives a response with no content-type', async () => {
    const bare = vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), json: async () => good });
    await expect(loadRuntimeConfig(bare as unknown as typeof fetch, {})).resolves.toBeNull();
  });
});
