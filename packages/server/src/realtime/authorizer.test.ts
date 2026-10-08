import { describe, expect, it, vi } from 'vitest';
import { createLogger, silentLogger } from '../log.js';
import type { League, Team } from '../repos/types.js';
import { createAuthorizer, handler } from './authorizer-lambda.js';
import {
  authorizeSubscribe,
  createSubscribeHandler,
  parseChannel,
  type SubscribeRepos
} from './authorizer.js';
import { GLOBAL_CHANNEL, leagueChannel, seatTenureKey, teamChannel } from './realtime.js';

const team = (id: string, ownerUserId: string | null, occupiedSince = '2026-09-01T00:00:00.000Z') =>
  ({ leagueId: 'lg-1', id, ownerUserId, occupiedSince, createdAt: '2026-08-01T00:00:00.000Z' }) as Team;

/** lg-1: Alice (commissioner) holds team-1, Bob team-2; team-3 is an AI seat. */
function repos(teams: Team[] = [team('team-1', 'alice'), team('team-2', 'bob'), team('team-3', null)]) {
  const league = { id: 'lg-1', commissionerId: 'alice' } as League;
  return {
    leagues: { get: async (id: string) => (id === 'lg-1' ? league : null) },
    teams: {
      list: async (leagueId: string) => (leagueId === 'lg-1' ? teams : []),
      get: async (leagueId: string, teamId: string) =>
        leagueId === 'lg-1' ? (teams.find((t) => t.id === teamId) ?? null) : null
    }
  } satisfies SubscribeRepos;
}

const bobsChannel = teamChannel('lg-1', 'team-2', seatTenureKey(team('team-2', 'bob')));

describe('parseChannel', () => {
  it('reads the three channel kinds and nothing else', () => {
    expect(parseChannel('/fantasy/global')).toEqual({ kind: 'global' });
    expect(parseChannel('/fantasy/league/lg-1')).toEqual({ kind: 'league', leagueId: 'lg-1' });
    expect(parseChannel('/fantasy/team/lg-1/team-2/abc123')).toEqual({
      kind: 'team',
      leagueId: 'lg-1',
      teamId: 'team-2',
      tenureKey: 'abc123'
    });
    for (const path of [
      'fantasy/global',
      '/other/global',
      '/fantasy/global/x',
      '/fantasy/league',
      '/fantasy/league/lg-1/x',
      '/fantasy/team/lg-1/team-2',
      '/fantasy/elsewhere/lg-1',
      // Wildcards would reach every league or team.
      '/fantasy/*',
      '/fantasy/league/*',
      '/fantasy/team/lg-1/*/x',
      '/fantasy/league/lg_1',
      `/fantasy/league/${'x'.repeat(51)}`
    ]) {
      expect(parseChannel(path), path).toBeNull();
    }
  });
});

describe('authorizeSubscribe', () => {
  it('lets any signed-in person hear the global channel', async () => {
    expect(await authorizeSubscribe(repos(), 'stranger', GLOBAL_CHANNEL)).toBeNull();
  });

  it('lets league members and the commissioner hear the league, and no one else', async () => {
    const seatless = repos([team('team-1', 'carol'), team('team-2', 'bob')]);
    expect(await authorizeSubscribe(repos(), 'bob', leagueChannel('lg-1'))).toBeNull();
    // A commissioner without a seat is still a member.
    expect(await authorizeSubscribe(seatless, 'alice', leagueChannel('lg-1'))).toBeNull();
    expect(await authorizeSubscribe(repos(), 'stranger', leagueChannel('lg-1'))).toBe(
      'You are not a member of this league.'
    );
    expect(await authorizeSubscribe(repos(), 'bob', leagueChannel('lg-2'))).toBe(
      'You are not a member of this league.'
    );
  });

  it("lets only the team's current owner hear the team, for the current tenure", async () => {
    const r = repos();
    expect(await authorizeSubscribe(r, 'bob', bobsChannel)).toBeNull();
    // Someone else in the league, the AI seat's channel, a team that does not exist.
    expect(await authorizeSubscribe(r, 'alice', bobsChannel)).toBe('You do not hold this seat.');
    const aiChannel = teamChannel('lg-1', 'team-3', seatTenureKey(team('team-3', null)));
    expect(await authorizeSubscribe(r, 'bob', aiChannel)).toBe('You do not hold this seat.');
    expect(await authorizeSubscribe(r, 'bob', teamChannel('lg-1', 'team-9', 'k'))).toBe(
      'You do not hold this seat.'
    );
    // A made-up or stale key.
    expect(await authorizeSubscribe(r, 'bob', teamChannel('lg-1', 'team-2', 'deadbeef'))).toBe(
      'This channel is for an earlier seat tenure.'
    );
  });

  it('refuses a former owner, and the old channel, once the seat changes hands', async () => {
    // Bob left; Dave took the seat.
    const after = repos([team('team-1', 'alice'), team('team-2', 'dave', '2026-09-20T00:00:00.000Z')]);
    expect(await authorizeSubscribe(after, 'bob', bobsChannel)).toBe('You do not hold this seat.');
    expect(await authorizeSubscribe(after, 'bob', leagueChannel('lg-1'))).toBe(
      'You are not a member of this league.'
    );
    // Dave cannot use Bob's channel either: his is a new one.
    expect(await authorizeSubscribe(after, 'dave', bobsChannel)).toBe(
      'This channel is for an earlier seat tenure.'
    );
    const davesChannel = teamChannel(
      'lg-1',
      'team-2',
      seatTenureKey(team('team-2', 'dave', '2026-09-20T00:00:00.000Z'))
    );
    expect(davesChannel).not.toBe(bobsChannel);
    expect(await authorizeSubscribe(after, 'dave', davesChannel)).toBeNull();
    // Bob back in the same seat later is a new tenure too.
    const back = repos([team('team-2', 'bob', '2026-09-27T00:00:00.000Z')]);
    expect(await authorizeSubscribe(back, 'bob', bobsChannel)).toBe(
      'This channel is for an earlier seat tenure.'
    );
  });

  it('refuses unknown channels and wildcards', async () => {
    expect(await authorizeSubscribe(repos(), 'bob', '/fantasy/*')).toBe('Unknown channel.');
  });
});

describe('the OnSubscribe handler', () => {
  const request = (sub: unknown, path: unknown, operation: unknown = 'SUBSCRIBE') => ({
    identity: { sub, issuer: 'https://cognito-idp', claims: {} },
    info: { operation, channel: { path, segments: [] }, channelNamespace: { name: 'fantasy' } }
  });

  it('allows with no response and refuses with an error, logging why', async () => {
    const lines: string[] = [];
    const handle = createSubscribeHandler(repos(), createLogger({ sink: (l) => lines.push(l) }));
    expect(await handle(request('bob', bobsChannel))).toBeNull();
    expect(await handle(request('alice', bobsChannel))).toEqual({ error: 'You do not hold this seat.' });
    expect(lines.join('\n')).toMatch(/realtime subscribe refused/);
  });

  it('refuses requests without a signed-in subscriber or a channel, and publishes', async () => {
    const handle = createSubscribeHandler(repos(), silentLogger);
    expect(await handle(request('', GLOBAL_CHANNEL))).toEqual({ error: 'Sign in to subscribe.' });
    expect(await handle({ identity: null, info: request('', GLOBAL_CHANNEL).info })).toEqual({
      error: 'Sign in to subscribe.'
    });
    expect(await handle(request('bob', GLOBAL_CHANNEL, 'PUBLISH'))).toEqual({
      error: 'Only subscribes are handled here.'
    });
    expect(await handle(request('bob', null))).toEqual({ error: 'Only subscribes are handled here.' });
    expect(await handle({})).toEqual({ error: 'Only subscribes are handled here.' });
    expect(await handle({ info: { operation: 'SUBSCRIBE', channel: null } })).toEqual({
      error: 'Only subscribes are handled here.'
    });
  });

  it('runs as a Lambda handler over the table', async () => {
    expect(() => createAuthorizer({})).toThrow(/TABLE_NAME/);
    expect(createAuthorizer({ TABLE_NAME: 'fantasy', LOG_LEVEL: 'error' })).toBeTypeOf('function');
    vi.stubEnv('TABLE_NAME', 'fantasy');
    try {
      // The global channel needs no table read.
      expect(await handler(request('bob', GLOBAL_CHANNEL))).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
