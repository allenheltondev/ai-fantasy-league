import { FixedClock } from '@fantasy/core';
import { describe, expect, it } from 'vitest';
import { localVerifier, startLocalServer } from '../../src/local.js';
import { silentLogger } from '../../src/log.js';

describe('local dev server', () => {
  it('serves the API on dynalite with fixture players and dev sign-in', async () => {
    const local = await startLocalServer({
      port: 0,
      env: { FANTASY_LOCAL_AUTH: '1' },
      clock: new FixedClock('2026-09-10T12:00:00Z'),
      log: silentLogger
    });
    try {
      const health = await fetch(`${local.url}/api/v1/health`);
      expect(await health.json()).toMatchObject({ data: { status: 'ok' } });
      const me = await fetch(`${local.url}/api/v1/me`, { headers: { authorization: 'Bearer dev:alice' } });
      expect(await me.json()).toMatchObject({ data: { type: 'user', sub: 'local-alice' } });
      const player = await fetch(`${local.url}/api/v1/players/lookup?player=cmc`, {
        headers: { authorization: 'Bearer dev' }
      });
      expect(await player.json()).toMatchObject({ data: { player: { id: 'fx-cmc' } } });
    } finally {
      await local.close();
    }
  });

  it('rejects dev tokens unless FANTASY_LOCAL_AUTH=1', async () => {
    const local = await startLocalServer({ port: 0, env: {}, log: silentLogger });
    try {
      const me = await fetch(`${local.url}/api/v1/me`, { headers: { authorization: 'Bearer dev' } });
      expect(me.status).toBe(401);
    } finally {
      await local.close();
    }
  });

  it('refuses to start inside Lambda', async () => {
    await expect(
      startLocalServer({ env: { FANTASY_LOCAL_AUTH: '1', AWS_LAMBDA_FUNCTION_NAME: 'fantasy-api' } })
    ).rejects.toThrow(/must not run inside Lambda/);
  });

  it('picks the verifier from the environment', () => {
    expect(localVerifier({})).toBeNull();
    expect(localVerifier({ USER_POOL_ID: 'us-east-1_abc', USER_POOL_CLIENT_ID: 'c' })).not.toBeNull();
    expect(localVerifier({ FANTASY_LOCAL_AUTH: '1', AWS_LAMBDA_FUNCTION_NAME: 'x' })).toBeNull();
  });
});
