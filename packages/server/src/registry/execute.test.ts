import { FixedClock } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { league, START } from '../../test/support/harness.js';
import { testRegistry } from '../../test/support/test-ops.js';
import { agentPrincipal, ANONYMOUS, type Principal } from '../auth/principal.js';
import { createContext } from '../context.js';
import { leagueAllowedActions, resolveActor } from '../league/phase.js';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { createLogger } from '../log.js';
import { fixturePlayers } from '../players/fixtures.js';
import { createInMemoryRepos, InMemoryAuditRepository } from '../repos/memory.js';
import { createServices } from '../services.js';
import { executeOperation, hashRequest, IDEMPOTENCY_LOCK_MS, IDEMPOTENCY_TTL_MS } from './execute.js';

const USER: Principal = { type: 'user', sub: 'user-123', email: 'a@example.com', name: 'Allen' };
const AGENT = agentPrincipal({ agentId: 'agent-1', teamId: 'team-2', leagueId: 'lg-1' });

async function setup(options: { phase?: 'setup' | 'playoffs' } = {}) {
  const repos = createInMemoryRepos({ players: fixturePlayers });
  await repos.leagues.create(league({ phase: options.phase ?? 'setup' }));
  const clock = new FixedClock(START);
  const lines: string[] = [];
  const log = createLogger({ sink: (line) => lines.push(line) });
  const events = new InMemoryEventPublisher();
  const services = createServices({ clock, repos, events, log });
  const run = (
    name: string,
    input: Record<string, unknown>,
    principal: Principal = USER,
    idempotencyKey: string | null = null
  ) => {
    const operation = testRegistry.get(name);
    if (operation === undefined) throw new Error(name);
    return executeOperation({
      registry: testRegistry,
      operation,
      ctx: createContext(services, principal),
      input,
      idempotencyKey
    });
  };
  return { repos, clock, events, run, lines, audit: repos.audit as InMemoryAuditRepository };
}

const KEY = 'key-00000001';
const NO_FLAGS = { waiversOpen: false, preLock: false, tradeDeadlinePassed: false };
/** The commissioner (without a seat, in this fixture) during setup. */
const COMMISSIONER_SETUP_ACTIONS = [
  'configure_agent_seat',
  'create_invite',
  'delete_league',
  'pick_player',
  'post_message',
  'randomize_agent_seats',
  'remove_member',
  'rename_league',
  'rename_team',
  'revoke_invite',
  'set_seat_type',
  'start_draft',
  'transfer_commissioner',
  'update_league_settings'
];

describe('executeOperation', () => {
  it('wraps output in the envelope with league status and warnings', async () => {
    const { run, events } = await setup();
    const result = await run('rename_league', { leagueId: 'lg-1', name: 'New' }, USER, KEY);
    expect(result).toEqual({
      status: 200,
      replayed: false,
      body: {
        data: { id: 'lg-1', name: 'New' },
        league: {
          id: 'lg-1',
          phase: 'setup',
          week: null,
          flags: NO_FLAGS,
          allowedActions: COMMISSIONER_SETUP_ACTIONS
        },
        warnings: [{ code: 'RENAMED', message: 'League renamed to New.' }]
      }
    });
    expect(events.events).toHaveLength(1);
  });

  it('returns league null for requests not about a league', async () => {
    const { run } = await setup();
    const result = await run('get_health', {}, ANONYMOUS);
    expect(result.body).toMatchObject({ data: { status: 'ok', time: START }, league: null, warnings: [] });
  });

  it('enforces authentication and the user-only requirement', async () => {
    const { run } = await setup();
    expect((await run('get_me', {}, ANONYMOUS)).body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect((await run('user_only', {}, AGENT)).body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect((await run('user_only', {}, USER)).status).toBe(200);
  });

  it('keeps agents inside their own league', async () => {
    const { run } = await setup();
    const result = await run('rename_league', { leagueId: 'lg-other', name: 'X' }, AGENT, KEY);
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'FORBIDDEN', fix: 'Use leagueId "lg-1".' } });
  });

  it('reports invalid input with issues and a fix', async () => {
    const { run } = await setup();
    const result = await run('search_players', { limit: 500 });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { issues: [{ path: 'limit' }] } }
    });
  });

  it('checks the league phase before running', async () => {
    const { run, audit } = await setup({ phase: 'playoffs' });
    const result = await run('rename_league', { leagueId: 'lg-1', name: 'X' }, USER, KEY);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      error: {
        code: 'PHASE_NOT_ALLOWED',
        details: { phase: 'playoffs', allowedPhases: ['setup', 'drafting'] }
      }
    });
    const missing = await run('rename_league', { leagueId: 'nope', name: 'X' }, USER, KEY);
    expect(missing.body).toMatchObject({ error: { code: 'LEAGUE_NOT_FOUND' } });
    expect(audit.entries).toHaveLength(0);
  });

  describe('idempotency', () => {
    it('requires a well-formed key on mutations', async () => {
      const { run } = await setup();
      const missing = await run('rename_league', { leagueId: 'lg-1', name: 'X' });
      expect(missing.status).toBe(400);
      expect(missing.body).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
      const malformed = await run('rename_league', { leagueId: 'lg-1', name: 'X' }, USER, 'no spaces!');
      expect(malformed.body).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    });

    it('replays the stored response without running the handler again', async () => {
      const { run, events, repos } = await setup();
      const first = await run('rename_league', { leagueId: 'lg-1', name: 'New' }, USER, KEY);
      const second = await run('rename_league', { leagueId: 'lg-1', name: 'New' }, USER, KEY);
      expect(second).toEqual({ ...first, replayed: true });
      expect(events.events).toHaveLength(1);
      expect((await repos.leagues.get('lg-1'))?.version).toBe(2);
    });

    it('scopes keys per principal', async () => {
      const { run, events } = await setup();
      await run('rename_league', { leagueId: 'lg-1', name: 'New' }, USER, KEY);
      const other = await run('rename_league', { leagueId: 'lg-1', name: 'New' }, AGENT, KEY);
      expect(other.replayed).toBe(false);
      expect(events.events).toHaveLength(2);
    });

    it('rejects a key reused for a different request', async () => {
      const { run } = await setup();
      await run('rename_league', { leagueId: 'lg-1', name: 'New' }, USER, KEY);
      const reused = await run('rename_league', { leagueId: 'lg-1', name: 'Other' }, USER, KEY);
      expect(reused.status).toBe(422);
      expect(reused.body).toMatchObject({
        error: { code: 'IDEMPOTENCY_KEY_REUSED', details: { originalOperation: 'rename_league' } }
      });
    });

    it('reports a request still in progress', async () => {
      const { run, repos, clock } = await setup();
      const now = clock.now();
      await repos.idempotency.begin({
        scope: 'user#user-123',
        key: KEY,
        operation: 'rename_league',
        requestHash: hashRequest('rename_league', { leagueId: 'lg-1', name: 'New' }),
        now,
        lockUntil: new Date(now.getTime() + IDEMPOTENCY_LOCK_MS),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS)
      });
      const busy = await run('rename_league', { name: 'New', leagueId: 'lg-1' }, USER, KEY);
      expect(busy.body).toMatchObject({ error: { code: 'IDEMPOTENCY_IN_PROGRESS' } });
      clock.advance(IDEMPOTENCY_LOCK_MS);
      const retaken = await run('rename_league', { name: 'New', leagueId: 'lg-1' }, USER, KEY);
      expect(retaken.status).toBe(200);
    });

    it('stores 4xx handler errors for replay and audits them', async () => {
      const { run, audit } = await setup();
      const input = { leagueId: 'lg-1', name: 'X', fail: 'NOT_YOUR_TURN' };
      const first = await run('rename_league', input, USER, KEY);
      expect(first.status).toBe(409);
      const second = await run('rename_league', input, USER, KEY);
      expect(second.replayed).toBe(true);
      expect(audit.entries).toEqual([
        expect.objectContaining({ operation: 'rename_league', outcome: 'error', errorCode: 'NOT_YOUR_TURN' })
      ]);
    });

    it('releases the key after a CONFLICT (a write race) so a retry with the same key runs again', async () => {
      const { run, audit } = await setup();
      const input = { leagueId: 'lg-1', name: 'X', fail: 'CONFLICT' };
      const first = await run('rename_league', input, USER, KEY);
      expect(first.body).toMatchObject({ error: { code: 'CONFLICT' } });
      const retried = await run('rename_league', input, USER, KEY);
      expect(retried.replayed).toBe(false);
      expect(audit.entries.map((e) => e.errorCode)).toEqual(['CONFLICT', 'CONFLICT']);
    });

    it('releases the key after a 5xx so a retry runs again', async () => {
      const { run, lines, audit } = await setup();
      const first = await run('explode', {}, USER, KEY);
      expect(first.status).toBe(500);
      expect(first.body).toMatchObject({ error: { code: 'INTERNAL' } });
      const second = await run('explode', {}, USER, KEY);
      expect(second.replayed).toBe(false);
      expect(second.status).toBe(500);
      expect(lines.some((l) => l.includes('operation failed'))).toBe(true);
      expect(audit.entries).toHaveLength(2);
    });
  });

  it('audits every mutation with principal and operation', async () => {
    const { run, audit } = await setup();
    await run('rename_league', { leagueId: 'lg-1', name: 'New' }, AGENT, KEY);
    await run('search_players', { q: 'cmc' });
    expect(audit.entries).toEqual([
      {
        id: expect.any(String),
        at: START,
        principal: 'agent#agent-1',
        principalType: 'agent',
        teamId: 'team-2',
        operation: 'rename_league',
        leagueId: 'lg-1',
        idempotencyKey: KEY,
        outcome: 'ok',
        errorCode: null
      }
    ]);
  });

  it('logs but does not fail when the audit write fails', async () => {
    const { run, audit, lines } = await setup();
    vi.spyOn(audit, 'record').mockRejectedValue(new Error('table down'));
    const result = await run('rename_league', { leagueId: 'lg-1', name: 'New' }, USER, KEY);
    expect(result.status).toBe(200);
    expect(lines.some((l) => l.includes('audit write failed'))).toBe(true);
  });

  it('turns output that breaks the schema into INTERNAL', async () => {
    const { run, lines } = await setup();
    const result = await run('bad_output', {});
    expect(result.status).toBe(500);
    expect(lines.some((l) => l.includes('does not match its schema'))).toBe(true);
  });

  it('computes allowed actions from the league rules and each operation phases', () => {
    const playoffs = league({ phase: 'playoffs' });
    const actor = resolveActor(playoffs, [], USER);
    expect(leagueAllowedActions(testRegistry.operations, playoffs, actor, new Date(START))).toEqual([
      'configure_agent_seat',
      'pick_player',
      'post_message',
      'rename_team',
      'transfer_commissioner',
      'update_league_settings'
    ]);
    const outsider = resolveActor(playoffs, [], { ...USER, sub: 'someone-else' } as Principal);
    expect(leagueAllowedActions(testRegistry.operations, playoffs, outsider, new Date(START))).toEqual([]);
  });

  it('gives outsiders an empty allowedActions list in the envelope', async () => {
    const { run } = await setup();
    const other: Principal = { type: 'user', sub: 'stranger', email: null, name: 'S' };
    const result = await run('rename_league', { leagueId: 'lg-1', name: 'Mine' }, other, KEY);
    expect(result.body).toMatchObject({ league: { allowedActions: [] } });
  });

  it('hashes requests independent of key order and undefined fields', () => {
    expect(hashRequest('op', { a: 1, b: [{ y: 2, x: 1 }] })).toBe(
      hashRequest('op', { b: [{ x: 1, y: 2 }], a: 1, c: undefined })
    );
    expect(hashRequest('op', { a: 1 })).not.toBe(hashRequest('other', { a: 1 }));
  });
});
