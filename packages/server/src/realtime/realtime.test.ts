import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { FixedClock } from '@fantasy/core';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, silentLogger } from '../log.js';
import {
  LazyMomentoRealtime,
  awsConfigReader,
  realtimeFromEnv,
  realtimeSourcesFromEnv,
  resolveMomentoSettings,
  type ConfigReader
} from './config.js';
import { createRelayDeps, handler } from './lambda.js';
import { MomentoRealtime, createMomentoClients, type MomentoClients } from './momento.js';
import { GLOBAL_TOPIC, InMemoryRealtime, leagueTopic } from './realtime.js';
import { RELAYED_EVENTS, TEAM_ONLY_EVENTS, relayEvent } from './relay.js';

vi.mock('@gomomento/sdk', () => {
  class PublishError {
    message() {
      return 'publish denied';
    }
  }
  class TokenSuccess {
    authToken = 'disposable';
    endpoint = 'cell.example';
    expiresAt = { epoch: () => 1_900_000_000 };
  }
  const calls: unknown[] = [];
  let fail = false;
  return {
    __calls: calls,
    __fail: (value: boolean) => {
      fail = value;
    },
    CredentialProvider: { fromString: (props: unknown) => ({ provider: props }) },
    TopicConfigurations: { Lambda: { latest: () => 'lambda-config' } },
    TopicRole: { SubscribeOnly: 'subscribeonly' },
    ExpiresIn: { seconds: (s: number) => ({ seconds: s }) },
    TopicPublish: { Error: PublishError },
    GenerateDisposableToken: { Success: TokenSuccess },
    TopicClient: class {
      constructor(props: unknown) {
        calls.push(['TopicClient', props]);
      }
      async publish(...args: unknown[]) {
        calls.push(['publish', ...args]);
        return fail ? new PublishError() : {};
      }
    },
    AuthClient: class {
      constructor(props: unknown) {
        calls.push(['AuthClient', props]);
      }
      async generateDisposableToken(...args: unknown[]) {
        calls.push(['generateDisposableToken', ...args]);
        return fail ? { message: () => 'token denied' } : new TokenSuccess();
      }
    }
  };
});

const clock = new FixedClock('2026-09-10T12:00:00.000Z');

function fakeClients(): MomentoClients & { published: unknown[]; tokenRequests: unknown[] } {
  const published: unknown[] = [];
  const tokenRequests: unknown[] = [];
  return {
    published,
    tokenRequests,
    topics: {
      async publish(cacheName, topic, value) {
        published.push({ cacheName, topic, value: JSON.parse(value) });
      }
    },
    tokens: {
      async subscribeOnlyToken(input) {
        tokenRequests.push(input);
        return { token: 'tok', endpoint: null, expiresAtEpochSeconds: Number.POSITIVE_INFINITY };
      }
    }
  };
}

describe('topics', () => {
  it('names one topic per league plus a global one', () => {
    expect(leagueTopic('lg-1')).toBe('fantasy.league.lg-1');
    expect(GLOBAL_TOPIC).toBe('fantasy.global');
  });
});

describe('InMemoryRealtime', () => {
  it('issues no tokens and records publishes', async () => {
    const realtime = new InMemoryRealtime();
    expect(await realtime.issueSubscribeToken()).toBeNull();
    await realtime.publish('t', { type: 'chat', leagueId: 'lg-1', message: { id: 'm' } });
    expect(realtime.published).toEqual([
      { topic: 't', message: { type: 'chat', leagueId: 'lg-1', message: { id: 'm' } } }
    ]);
  });
});

describe('MomentoRealtime', () => {
  it('issues subscribe-only tokens for the league, team, and global topics, with a bounded ttl', async () => {
    const clients = fakeClients();
    const realtime = new MomentoRealtime({ clients, cacheName: 'cache', clock });
    const token = await realtime.issueSubscribeToken({
      leagueId: 'lg-1',
      teamId: 'team-2',
      subscriber: 'user#a',
      ttlSeconds: 99_999
    });
    expect(clients.tokenRequests).toEqual([
      {
        cacheName: 'cache',
        topics: ['fantasy.league.lg-1', 'fantasy.global', 'fantasy.team.lg-1.team-2'],
        ttlSeconds: 3600,
        tokenId: 'user#a'
      }
    ]);
    expect(token).toEqual({
      token: 'tok',
      endpoint: null,
      cacheName: 'cache',
      topics: { league: 'fantasy.league.lg-1', global: 'fantasy.global', team: 'fantasy.team.lg-1.team-2' },
      expiresAt: '2026-09-10T13:00:00.000Z'
    });
    const seatless = await realtime.issueSubscribeToken({
      leagueId: 'lg-1',
      teamId: null,
      subscriber: 'user#a',
      ttlSeconds: 1
    });
    expect((clients.tokenRequests[1] as { ttlSeconds: number }).ttlSeconds).toBe(60);
    expect((clients.tokenRequests[1] as { topics: string[] }).topics).toEqual([
      'fantasy.league.lg-1',
      'fantasy.global'
    ]);
    expect(seatless.topics.team).toBeNull();
  });

  it('uses the expiry Momento reports', async () => {
    const clients = fakeClients();
    clients.tokens.subscribeOnlyToken = async () => ({
      token: 't',
      endpoint: 'e',
      expiresAtEpochSeconds: 1_900_000_000
    });
    const token = await new MomentoRealtime({ clients, cacheName: 'c', clock }).issueSubscribeToken({
      leagueId: 'lg-1',
      teamId: null,
      subscriber: 's',
      ttlSeconds: 600
    });
    expect(token.expiresAt).toBe(new Date(1_900_000_000_000).toISOString());
  });

  it('publishes JSON to the cache', async () => {
    const clients = fakeClients();
    await new MomentoRealtime({ clients, cacheName: 'cache', clock }).publish('topic', {
      type: 'chat',
      leagueId: 'lg-1',
      message: { id: 'm' }
    });
    expect(clients.published).toEqual([
      { cacheName: 'cache', topic: 'topic', value: { type: 'chat', leagueId: 'lg-1', message: { id: 'm' } } }
    ]);
  });
});

describe('createMomentoClients', () => {
  it('adapts the Momento SDK', async () => {
    const sdk = (await import('@gomomento/sdk')) as unknown as {
      __calls: unknown[];
      __fail(v: boolean): void;
    };
    const clients = await createMomentoClients('api-key');
    await clients.topics.publish('cache', 'topic', 'v');
    const token = await clients.tokens.subscribeOnlyToken({
      cacheName: 'cache',
      topics: ['a', 'b'],
      ttlSeconds: 600,
      tokenId: 'user#a'
    });
    expect(token).toEqual({
      token: 'disposable',
      endpoint: 'cell.example',
      expiresAtEpochSeconds: 1_900_000_000
    });
    expect(sdk.__calls).toEqual([
      [
        'TopicClient',
        { configuration: 'lambda-config', credentialProvider: { provider: { apiKey: 'api-key' } } }
      ],
      ['AuthClient', { credentialProvider: { provider: { apiKey: 'api-key' } } }],
      ['publish', 'cache', 'topic', 'v'],
      [
        'generateDisposableToken',
        {
          permissions: [
            { role: 'subscribeonly', cache: 'cache', topic: 'a' },
            { role: 'subscribeonly', cache: 'cache', topic: 'b' }
          ]
        },
        { seconds: 600 },
        { tokenId: 'user#a' }
      ]
    ]);
    sdk.__fail(true);
    await expect(clients.topics.publish('cache', 'topic', 'v')).rejects.toThrow(/publish denied/);
    await expect(
      clients.tokens.subscribeOnlyToken({ cacheName: 'c', topics: [], ttlSeconds: 60, tokenId: 'x' })
    ).rejects.toThrow(/token denied/);
    sdk.__fail(false);
  });
});

describe('realtime configuration', () => {
  it('is on only with both a key source and a cache source', () => {
    expect(realtimeSourcesFromEnv({})).toBeNull();
    expect(realtimeSourcesFromEnv({ SECRET_ID: 'arn:secret' })).toBeNull();
    expect(realtimeSourcesFromEnv({ MOMENTO_CACHE_NAME: 'c', MOMENTO_API_KEY: '  ' })).toBeNull();
    expect(
      realtimeSourcesFromEnv({
        SECRET_ID: 'arn:secret',
        SECRETS_PARAMETER_NAME: '/readysetcloud/secrets',
        MOMENTO_CACHE_PARAMETER: '/readysetcloud/cache-name'
      })
    ).toEqual({
      secretId: 'arn:secret',
      secretsParameter: '/readysetcloud/secrets',
      cacheParameter: '/readysetcloud/cache-name'
    });
    expect(realtimeSourcesFromEnv({ MOMENTO_API_KEY: 'k', MOMENTO_CACHE_NAME: 'c' })).toEqual({
      apiKey: 'k',
      cacheName: 'c'
    });
    expect(realtimeFromEnv({}, { clock, log: silentLogger })).toBeInstanceOf(InMemoryRealtime);
    expect(
      realtimeFromEnv({ MOMENTO_API_KEY: 'k', MOMENTO_CACHE_NAME: 'c' }, { clock, log: silentLogger })
    ).toBeInstanceOf(LazyMomentoRealtime);
  });

  const reader = (values: Record<string, string | undefined>): ConfigReader & { reads: string[] } => {
    const reads: string[] = [];
    return {
      reads,
      parameter: async (name) => {
        reads.push(`ssm:${name}`);
        return values[`ssm:${name}`];
      },
      secret: async (id) => {
        reads.push(`secret:${id}`);
        return values[`secret:${id}`];
      }
    };
  };

  it('reads the key from the rsc-core secret and the cache from SSM', async () => {
    const r = reader({
      'ssm:/readysetcloud/secrets': 'arn:secret',
      'secret:arn:secret': JSON.stringify({ momento: 'the-key', openai: 'x' }),
      'ssm:/readysetcloud/cache-name': 'readysetcloud'
    });
    expect(
      await resolveMomentoSettings(
        { secretsParameter: '/readysetcloud/secrets', cacheParameter: '/readysetcloud/cache-name' },
        r
      )
    ).toEqual({ apiKey: 'the-key', cacheName: 'readysetcloud' });
    expect(r.reads).toEqual([
      'ssm:/readysetcloud/secrets',
      'secret:arn:secret',
      'ssm:/readysetcloud/cache-name'
    ]);
    expect(await resolveMomentoSettings({ apiKey: 'k', cacheName: 'c' }, reader({}))).toEqual({
      apiKey: 'k',
      cacheName: 'c'
    });
  });

  it('explains what is missing', async () => {
    await expect(
      resolveMomentoSettings({ secretsParameter: '/p', cacheName: 'c' }, reader({}))
    ).rejects.toThrow(/parameter has no value/);
    for (const secret of [undefined, 'not json', '{"openai":"x"}', '[]']) {
      await expect(
        resolveMomentoSettings({ secretId: 'arn', cacheName: 'c' }, reader({ 'secret:arn': secret }))
      ).rejects.toThrow(/no "momento" API key/);
    }
    await expect(resolveMomentoSettings({ apiKey: 'k', cacheParameter: '/c' }, reader({}))).rejects.toThrow(
      /cache name is not set/
    );
  });

  it('reads SSM parameters and Secrets Manager secrets through the AWS SDK', async () => {
    const ssm = vi
      .spyOn(SSMClient.prototype, 'send')
      .mockImplementation(async () => ({ Parameter: { Value: 'v' } }));
    const secrets = vi
      .spyOn(SecretsManagerClient.prototype, 'send')
      .mockImplementation(async () => ({ SecretString: '{"momento":"k"}' }));
    try {
      const r = awsConfigReader();
      expect(await r.parameter('/p')).toBe('v');
      expect(await r.secret('arn')).toBe('{"momento":"k"}');
      expect(ssm).toHaveBeenCalledOnce();
      expect(secrets).toHaveBeenCalledOnce();
    } finally {
      ssm.mockRestore();
      secrets.mockRestore();
    }
  });
});

describe('LazyMomentoRealtime', () => {
  it('sets up once, then issues tokens and publishes', async () => {
    const clients = fakeClients();
    let builds = 0;
    const realtime = new LazyMomentoRealtime({
      sources: { apiKey: 'k', cacheName: 'c' },
      clock,
      log: silentLogger,
      clients: async (apiKey) => {
        builds++;
        expect(apiKey).toBe('k');
        return clients;
      }
    });
    expect(
      await realtime.issueSubscribeToken({ leagueId: 'lg-1', teamId: null, subscriber: 's', ttlSeconds: 600 })
    ).toMatchObject({
      token: 'tok',
      cacheName: 'c'
    });
    await realtime.publish('t', { type: 'chat', leagueId: 'lg-1', message: {} });
    expect(builds).toBe(1);
    expect(clients.published).toHaveLength(1);
  });

  it('falls back to polling when setup fails, and retries setup next time', async () => {
    const lines: string[] = [];
    let attempts = 0;
    const realtime = new LazyMomentoRealtime({
      sources: { secretId: 'arn', cacheName: 'c' },
      clock,
      log: createLogger({ sink: (l) => lines.push(l) }),
      reader: {
        parameter: async () => undefined,
        secret: async () => {
          attempts++;
          return attempts === 1 ? '{}' : '{"momento":"k"}';
        }
      },
      clients: async () => fakeClients()
    });
    expect(
      await realtime.issueSubscribeToken({ leagueId: 'lg-1', teamId: null, subscriber: 's', ttlSeconds: 600 })
    ).toBeNull();
    expect(lines.join('\n')).toMatch(/realtime token unavailable/);
    await realtime.publish('t', { type: 'chat', leagueId: 'lg-1', message: {} });
    expect(attempts).toBe(2);
  });

  it('throws publish failures so the event is retried', async () => {
    const realtime = new LazyMomentoRealtime({
      sources: { apiKey: 'k', cacheParameter: '/c' },
      clock,
      log: silentLogger,
      reader: { parameter: async () => undefined, secret: async () => undefined }
    });
    await expect(realtime.publish('t', { type: 'chat', leagueId: 'lg-1', message: {} })).rejects.toThrow(
      /cache name/
    );
  });
});

describe('relayEvent', () => {
  const event = (detailType: string, detail: unknown, source = 'fantasy') => ({
    id: 'evt-1',
    source,
    'detail-type': detailType,
    time: '2026-09-10T12:00:00Z',
    detail
  });

  it('pushes chat messages to the league topic', async () => {
    const realtime = new InMemoryRealtime();
    const result = await relayEvent(
      realtime,
      silentLogger,
      event('Chat Message Posted', { leagueId: 'lg-1', message: { id: 'm1', text: 'hi' } })
    );
    expect(result).toEqual({ topics: ['fantasy.league.lg-1'] });
    expect(realtime.published[0]?.message).toEqual({
      type: 'chat',
      leagueId: 'lg-1',
      message: { id: 'm1', text: 'hi' }
    });
    expect(
      await relayEvent(realtime, silentLogger, event('Chat Message Posted', { leagueId: 'lg-1' }))
    ).toEqual({
      topics: []
    });
  });

  it('pushes DM messages only to the two teams’ topics, and drops a DM it cannot address', async () => {
    const realtime = new InMemoryRealtime();
    const dm = { id: 'm2', roomId: 'dm-team-1-team-2', text: 'secret' };
    expect(
      await relayEvent(
        realtime,
        silentLogger,
        event('Chat Message Posted', {
          leagueId: 'lg-1',
          roomId: 'dm-team-1-team-2',
          teamIds: ['team-1', 'team-2'],
          message: dm
        })
      )
    ).toEqual({ topics: ['fantasy.team.lg-1.team-1', 'fantasy.team.lg-1.team-2'] });
    // No detail room but a DM message, or a DM without both teams: never the league topic.
    for (const detail of [
      { leagueId: 'lg-1', message: dm },
      { leagueId: 'lg-1', roomId: 'dm-team-1-team-2', teamIds: ['team-1', 'team-1'], message: dm },
      { leagueId: 'lg-1', roomId: 'dm-team-1-team-2', teamIds: null, message: dm }
    ]) {
      expect(await relayEvent(realtime, silentLogger, event('Chat Message Posted', detail))).toEqual({
        topics: []
      });
    }
    expect(realtime.published.map((p) => p.topic)).toEqual([
      'fantasy.team.lg-1.team-1',
      'fantasy.team.lg-1.team-2'
    ]);
    expect(
      await relayEvent(
        realtime,
        silentLogger,
        event('Chat Message Posted', {
          leagueId: 'lg-1',
          roomId: 'draft',
          teamIds: null,
          message: { id: 'm3' }
        })
      )
    ).toEqual({ topics: ['fantasy.league.lg-1'] });
  });

  it('passes league events through untouched, per league or globally', async () => {
    const realtime = new InMemoryRealtime();
    await relayEvent(realtime, silentLogger, event('Draft Pick Made', { leagueId: 'lg-1', pick: 3 }));
    await relayEvent(realtime, silentLogger, event('Scores Updated', { week: 5, playerIds: ['p'] }));
    await relayEvent(realtime, silentLogger, event('Waivers Processed', { leagueIds: ['a', 'b', 'a', 3] }));
    await relayEvent(realtime, silentLogger, { ...event('Trade Vetoed', 'not an object'), time: undefined });
    await relayEvent(
      realtime,
      silentLogger,
      event('NFL Games Updated', { season: 2026, week: 5, games: [] })
    );
    expect(realtime.published.map((p) => p.topic)).toEqual([
      'fantasy.league.lg-1',
      'fantasy.global',
      'fantasy.league.a',
      'fantasy.league.b',
      'fantasy.global',
      'fantasy.global'
    ]);
    expect(realtime.published.at(-1)?.message).toMatchObject({
      detailType: 'NFL Games Updated',
      leagueId: null,
      detail: { week: 5 }
    });
    expect(realtime.published[0]?.message).toEqual({
      type: 'event',
      detailType: 'Draft Pick Made',
      eventId: 'evt-1',
      time: '2026-09-10T12:00:00Z',
      leagueId: 'lg-1',
      detail: { leagueId: 'lg-1', pick: 3 }
    });
    expect(realtime.published[4]?.message).toMatchObject({ time: null, detail: {}, leagueId: null });
  });

  it('sends each team its own waiver awards on its private topic', async () => {
    const realtime = new InMemoryRealtime();
    const awarded = [
      { teamId: 'team-1', playerId: 'p1' },
      { teamId: 'team-2', playerId: 'p2' },
      { teamId: 'team-1', playerId: 'p3' },
      null,
      { playerId: 'p4' }
    ];
    const result = await relayEvent(
      realtime,
      silentLogger,
      event('Waivers Processed', { leagueId: 'lg-1', week: 5, awarded })
    );
    expect(result.topics).toEqual([
      'fantasy.league.lg-1',
      'fantasy.team.lg-1.team-1',
      'fantasy.team.lg-1.team-2'
    ]);
    expect(realtime.published[1]?.message).toMatchObject({
      leagueId: 'lg-1',
      detail: { teamId: 'team-1', week: 5, awarded: [awarded[0], awarded[2]] }
    });
    expect(
      (
        await relayEvent(
          realtime,
          silentLogger,
          event('Waivers Processed', { leagueId: 'lg-1', awarded: 'x' })
        )
      ).topics
    ).toEqual(['fantasy.league.lg-1']);
  });

  it('keeps failed waiver claims off the league topic and sends each team its own (#165)', async () => {
    const realtime = new InMemoryRealtime();
    const lost = [
      { teamId: 'team-2', playerId: 'p9', reason: 'Outbid.' },
      { teamId: 'team-3', playerId: 'p8', reason: 'Roster full.' }
    ];
    const result = await relayEvent(
      realtime,
      silentLogger,
      event('Waivers Processed', { leagueId: 'lg-1', awarded: [{ teamId: 'team-1', playerId: 'p1' }], lost })
    );
    expect(result.topics).toEqual([
      'fantasy.league.lg-1',
      'fantasy.team.lg-1.team-1',
      'fantasy.team.lg-1.team-2',
      'fantasy.team.lg-1.team-3'
    ]);
    expect(realtime.published[0]?.message).toMatchObject({ detail: { awarded: [{ teamId: 'team-1' }] } });
    expect(JSON.stringify(realtime.published[0]?.message)).not.toContain('p9');
    expect(realtime.published[1]?.message).toMatchObject({ detail: { teamId: 'team-1', lost: [] } });
    expect(realtime.published[2]?.message).toMatchObject({
      detail: { teamId: 'team-2', awarded: [], lost: [lost[0]] }
    });
  });

  it('sends a new notification to its team’s topic alone (#165)', async () => {
    const realtime = new InMemoryRealtime();
    const result = await relayEvent(
      realtime,
      silentLogger,
      event('Notification Created', { leagueId: 'lg-1', teamId: 'team-2', notification: { id: 'n1' } })
    );
    expect(result.topics).toEqual(['fantasy.team.lg-1.team-2']);
    expect(
      (await relayEvent(realtime, silentLogger, event('Notification Created', { leagueId: 'lg-1' }))).topics
    ).toEqual([]);
  });

  it('ignores other events and other sources', async () => {
    const realtime = new InMemoryRealtime();
    expect(await relayEvent(realtime, silentLogger, event('League Created', { leagueId: 'x' }))).toEqual({
      topics: []
    });
    expect(await relayEvent(realtime, silentLogger, event('Draft Pick Made', {}, 'other'))).toEqual({
      topics: []
    });
    expect(realtime.published).toEqual([]);
    expect(RELAYED_EVENTS).toContain('Chat Message Posted');
  });

  it('keeps pending trade offers off the league topic: only the two teams see them', async () => {
    const realtime = new InMemoryRealtime();
    for (const detailType of TEAM_ONLY_EVENTS) {
      const detail = { leagueId: 'lg-1', tradeId: 't1', fromTeamId: 'team-1', toTeamId: 'team-2' };
      expect(await relayEvent(realtime, silentLogger, event(detailType, detail))).toEqual({
        topics: ['fantasy.team.lg-1.team-1', 'fantasy.team.lg-1.team-2']
      });
    }
    expect(realtime.published.some((p) => p.topic.startsWith('fantasy.league.'))).toBe(false);
    expect(realtime.published[0]?.message).toMatchObject({ detailType: 'Trade Proposed', leagueId: 'lg-1' });
    // Without a single league, or without team ids, an offer goes nowhere.
    expect(
      await relayEvent(realtime, silentLogger, event('Trade Proposed', { fromTeamId: 'team-1' }))
    ).toEqual({ topics: [] });
    expect(
      await relayEvent(realtime, silentLogger, event('Trade Proposed', { leagueId: 'lg-1', toTeamId: '' }))
    ).toEqual({ topics: [] });
    expect(await relayEvent(realtime, silentLogger, event('Trade Accepted', { leagueId: 'lg-1' }))).toEqual({
      topics: ['fantasy.league.lg-1']
    });
  });

  it('runs as a Lambda handler with realtime off when nothing is configured', async () => {
    const deps = createRelayDeps({ LOG_LEVEL: 'error' });
    expect(deps.realtime).toBeInstanceOf(InMemoryRealtime);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await handler(event('Draft Pick Made', { leagueId: 'lg-1' }))).toEqual({
        topics: ['fantasy.league.lg-1']
      });
    } finally {
      stdout.mockRestore();
    }
  });
});
