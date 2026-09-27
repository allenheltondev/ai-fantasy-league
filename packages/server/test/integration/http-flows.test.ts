import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, league, type Harness } from '../support/harness.js';
import { signIdToken } from '../support/tokens.js';

/** Full HTTP flows through the Hono app against dynalite, with real token verification. */
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ backend: 'dynamo' });
  await h.repos.leagues.create(league({ id: 'lg-flow' }));
});
afterAll(() => h.close());

describe('HTTP flows (dynalite)', () => {
  it('health needs no sign-in', async () => {
    const res = await h.request('/api/v1/health', { token: null });
    expect(res).toMatchObject({
      status: 200,
      body: {
        data: { status: 'ok', version: '1.0.0', time: '2026-09-10T12:00:00.000Z' },
        league: null,
        warnings: []
      }
    });
  });

  it('get_me returns the verified user and requires sign-in', async () => {
    const me = await h.request('/api/v1/me', {
      token: signIdToken({ sub: 'u-9', name: 'Pat', email: 'p@x.io' })
    });
    expect(me.body).toEqual({
      data: { type: 'user', sub: 'u-9', email: 'p@x.io', name: 'Pat' },
      league: null,
      warnings: []
    });
    const anonymous = await h.request('/api/v1/me', { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({
      error: { code: 'UNAUTHENTICATED', fix: expect.stringContaining('Bearer') }
    });
  });

  it('searches players compactly by default and in detail on request', async () => {
    const compact = await h.request('/api/v1/players?q=mccaffrey%20sf');
    expect(compact.body).toMatchObject({
      data: { players: [{ id: 'fx-cmc', name: 'Christian McCaffrey', team: 'SF', position: 'RB' }] }
    });
    expect(Object.keys((compact.body as { data: { players: object[] } }).data.players[0]!)).toEqual([
      'id',
      'name',
      'team',
      'position'
    ]);
    const detailed = await h.request('/api/v1/players?position=K&detail=true&limit=2');
    expect(detailed.body).toMatchObject({
      data: {
        players: [
          { id: 'fx-butker', status: 'active', rank: 150, aliases: [] },
          { id: 'fx-tucker', team: null, status: 'inactive', rank: null }
        ]
      }
    });
  });

  it('validates query input', async () => {
    const res = await h.request('/api/v1/players?limit=0&team=XYZ');
    expect(res.status).toBe(400);
    const issues = (res.body as { error: { details: { issues: { path: string }[] } } }).error.details.issues;
    expect(issues.map((i) => i.path).sort()).toEqual(['limit', 'team']);
  });

  it('resolves get_player by id, name, and nickname', async () => {
    for (const query of ['playerId=fx-arsb', 'player=ARSB', 'player=amon-ra%20st%20brown']) {
      const res = await h.request(`/api/v1/players/lookup?${query}`);
      expect(res.body).toMatchObject({ data: { player: { id: 'fx-arsb', name: 'Amon-Ra St. Brown' } } });
    }
  });

  it('returns AMBIGUOUS_PLAYER and PLAYER_NOT_FOUND with fixes', async () => {
    const ambiguous = await h.request('/api/v1/players/lookup?player=williams');
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body).toMatchObject({
      error: {
        code: 'AMBIGUOUS_PLAYER',
        fix: expect.stringContaining('playerId'),
        details: {
          candidates: expect.arrayContaining([
            { id: 'fx-mikew', name: 'Mike Williams', team: 'PIT', position: 'WR' }
          ])
        }
      }
    });
    const missing = await h.request('/api/v1/players/lookup?player=zzzz%20qqqq');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'PLAYER_NOT_FOUND', fix: expect.any(String) } });
  });

  it('runs a mutation once per Idempotency-Key, audits it, and returns league status', async () => {
    const init = { method: 'POST', idempotencyKey: 'flow-key-0001', body: { name: 'Dynasty' } };
    const first = await h.request('/api/v1/leagues/lg-flow/name', init);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      data: { id: 'lg-flow', name: 'Dynasty' },
      league: {
        id: 'lg-flow',
        phase: 'setup',
        week: null,
        allowedActions: ['configure_agent_seat', 'pick_player', 'randomize_agent_seats', 'rename_league']
      },
      warnings: [{ code: 'RENAMED' }]
    });
    const replay = await h.request('/api/v1/leagues/lg-flow/name', init);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await h.repos.leagues.get('lg-flow'))?.version).toBe(2);
    expect(h.events.events).toHaveLength(1);

    const reused = await h.request('/api/v1/leagues/lg-flow/name', { ...init, body: { name: 'Other' } });
    expect(reused.status).toBe(422);
    const noKey = await h.request('/api/v1/leagues/lg-flow/name', { method: 'POST', body: { name: 'X' } });
    expect(noKey.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    const audit = await h.repos.audit.listByLeague('lg-flow');
    expect(audit).toEqual([
      expect.objectContaining({
        principal: 'user#user-123',
        principalType: 'user',
        operation: 'rename_league',
        idempotencyKey: 'flow-key-0001',
        outcome: 'ok'
      })
    ]);
    expect(await h.repos.audit.listByPrincipal('user#user-123')).toHaveLength(1);
  });

  it('rejects mutations outside their phases', async () => {
    await h.repos.leagues.create(league({ id: 'lg-late', phase: 'playoffs' }));
    const res = await h.request('/api/v1/leagues/lg-late/name', {
      method: 'POST',
      idempotencyKey: 'flow-key-0002',
      body: { name: 'Late' }
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'PHASE_NOT_ALLOWED' } });
  });
});
