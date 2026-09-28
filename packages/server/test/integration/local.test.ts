import { FixedClock } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { localClock, localVerifier, startLocalServer } from '../../src/local.js';
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

  it('delivers events in process when asked, to its own and extra subscribers', async () => {
    const seen: string[] = [];
    const local = await startLocalServer({
      port: 0,
      env: { FANTASY_LOCAL_AUTH: '1' },
      clock: new FixedClock('2026-09-10T12:00:00Z'),
      log: silentLogger,
      eventLoop: {
        pollMs: 10,
        subscribers: () => [{ name: 'spy', handle: async (e) => void seen.push(e['detail-type']) }]
      }
    });
    try {
      expect(local.loop).not.toBeNull();
      const created = await fetch(`${local.url}/api/v1/leagues`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer dev:alice',
          'content-type': 'application/json',
          'idempotency-key': 'local-loop-1'
        },
        body: JSON.stringify({ name: 'Loop League' })
      });
      expect(created.status).toBe(200);
      await vi.waitFor(() => expect(seen).toContain('League Created'));
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

  it('pins the clock with FANTASY_LOCAL_NOW', async () => {
    expect(localClock({}).now()).toBeInstanceOf(Date);
    expect(localClock({ FANTASY_LOCAL_NOW: '' })).toBe(localClock({}));
    expect(localClock({ FANTASY_LOCAL_NOW: '2026-09-10T12:00:00Z' }).now().toISOString()).toBe(
      '2026-09-10T12:00:00.000Z'
    );
    expect(() => localClock({ FANTASY_LOCAL_NOW: 'soon' })).toThrow(/not a date/);
    const local = await startLocalServer({
      port: 0,
      env: { FANTASY_LOCAL_AUTH: '1', FANTASY_LOCAL_NOW: '2026-09-10T12:00:00Z' },
      log: silentLogger
    });
    try {
      expect(local.services.clock.now().toISOString()).toBe('2026-09-10T12:00:00.000Z');
    } finally {
      await local.close();
    }
  });

  it('seeds an in-season demo league with FANTASY_LOCAL_SEASON_DEMO', async () => {
    const local = await startLocalServer({
      port: 0,
      env: { FANTASY_LOCAL_AUTH: '1', FANTASY_LOCAL_SEASON_DEMO: 'coach' },
      log: silentLogger
    });
    try {
      const res = await fetch(`${local.url}/api/v1/leagues/demo-season/teams/team-1/roster`, {
        headers: { authorization: 'Bearer dev:coach' }
      });
      const body = (await res.json()) as { data: { lineupSaved: boolean; players: unknown[] } };
      expect(body.data).toMatchObject({ lineupSaved: true });
      expect(body.data.players).toHaveLength(13);
      const league = await local.services.repos.leagues.get('demo-season');
      expect(league).toMatchObject({ phase: 'regular_season', week: 1, commissionerId: 'local-coach' });
      const draftRoom = await fetch(`${local.url}/api/v1/leagues/demo-season/chat/messages?roomId=draft`, {
        headers: { authorization: 'Bearer dev:coach' }
      });
      const draft = (await draftRoom.json()) as { data: { messages: { kind: string; text: string }[] } };
      expect(draft.data.messages).toEqual([
        expect.objectContaining({ kind: 'system', text: 'The draft is complete. Good luck this season!' })
      ]);
      // Seeding again leaves the stored league alone.
      const { seedDemoSeason } = await import('../../src/dev/season-demo.js');
      const again = await seedDemoSeason(
        { repos: local.services.repos, reference: local.services.data.reference },
        { leagueId: 'demo-season', owner: { sub: 'someone', name: 'Someone' }, now: new Date() }
      );
      expect(again.commissionerId).toBe('local-coach');
    } finally {
      await local.close();
    }
  });
});
