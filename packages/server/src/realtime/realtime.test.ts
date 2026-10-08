import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log.js';
import { DynamoTeamRepository } from '../repos/dynamo/teams.js';
import type { Team } from '../repos/types.js';
import { AppSyncEventsRealtime } from './appsync.js';
import { realtimeFromEnv, realtimeSettingsFromEnv } from './config.js';
import { createRelayDeps, handler } from './lambda.js';
import { GLOBAL_CHANNEL, InMemoryRealtime, leagueChannel, seatTenureKey, teamChannel } from './realtime.js';
import { RELAYED_EVENTS, TEAM_ONLY_EVENTS, relayEvent } from './relay.js';

const team = (leagueId: string, id: string, overrides: Partial<Team> = {}) =>
  ({
    leagueId,
    id,
    ownerUserId: `owner-of-${id}`,
    occupiedSince: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  }) as Team;

/** Every team exists, held since the same moment. */
const teams = { get: async (leagueId: string, teamId: string) => team(leagueId, teamId) };
/** A team's channel for the tenure `teams` reports. */
const tc = (leagueId: string, teamId: string) =>
  teamChannel(leagueId, teamId, seatTenureKey(team(leagueId, teamId)));

/** The relay with every team in place. */
const relay = (...args: [InMemoryRealtime, typeof silentLogger, Parameters<typeof relayEvent>[2]]) =>
  relayEvent(...args, teams);

describe('channels', () => {
  it('names one channel per league, one per team tenure, and a global one, in the fantasy namespace', () => {
    expect(leagueChannel('lg-1')).toBe('/fantasy/league/lg-1');
    expect(GLOBAL_CHANNEL).toBe('/fantasy/global');
    expect(teamChannel('lg-1', 'team-2', 'abc')).toBe('/fantasy/team/lg-1/team-2/abc');
  });

  it('keys a team channel by who holds the seat and since when', () => {
    const key = seatTenureKey(team('lg-1', 'team-2'));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(seatTenureKey(team('lg-1', 'team-2'))).toBe(key);
    // A new occupant, a new tenure start, or another team: another key.
    expect(seatTenureKey(team('lg-1', 'team-2', { ownerUserId: null }))).not.toBe(key);
    expect(seatTenureKey(team('lg-1', 'team-2', { occupiedSince: '2026-09-02T00:00:00.000Z' }))).not.toBe(
      key
    );
    expect(seatTenureKey(team('lg-1', 'team-3'))).not.toBe(key);
    // A team stored before `occupiedSince` keys on its creation.
    expect(seatTenureKey(team('lg-1', 'team-2', { occupiedSince: undefined }))).toBe(
      seatTenureKey(team('lg-1', 'team-2', { occupiedSince: '2026-08-01T00:00:00.000Z' }))
    );
  });
});

describe('InMemoryRealtime', () => {
  it('has no endpoint and records publishes', async () => {
    const realtime = new InMemoryRealtime();
    expect(realtime.endpoint()).toBeNull();
    await realtime.publish('/fantasy/global', { type: 'chat', leagueId: 'lg-1', message: { id: 'm' } });
    expect(realtime.published).toEqual([
      { channel: '/fantasy/global', message: { type: 'chat', leagueId: 'lg-1', message: { id: 'm' } } }
    ]);
  });
});

describe('realtime configuration', () => {
  it('is on only with both Event API domains', () => {
    expect(realtimeSettingsFromEnv({})).toBeNull();
    expect(realtimeSettingsFromEnv({ REALTIME_HTTP_DOMAIN: 'h.example' })).toBeNull();
    expect(realtimeSettingsFromEnv({ REALTIME_HTTP_DOMAIN: 'h', REALTIME_WS_DOMAIN: '  ' })).toBeNull();
    expect(realtimeSettingsFromEnv({ REALTIME_HTTP_DOMAIN: ' h ', REALTIME_WS_DOMAIN: 'w' })).toEqual({
      httpHost: 'h',
      realtimeHost: 'w',
      region: 'us-east-1'
    });
    expect(
      realtimeSettingsFromEnv({ REALTIME_HTTP_DOMAIN: 'h', REALTIME_WS_DOMAIN: 'w', AWS_REGION: 'us-west-2' })
        ?.region
    ).toBe('us-west-2');
    expect(realtimeFromEnv({})).toBeInstanceOf(InMemoryRealtime);
    const on = realtimeFromEnv({ REALTIME_HTTP_DOMAIN: 'h', REALTIME_WS_DOMAIN: 'w' });
    expect(on).toBeInstanceOf(AppSyncEventsRealtime);
    expect(on.endpoint()).toEqual({ httpHost: 'h', realtimeHost: 'w' });
  });

  it('publishes signed, through the given seams', async () => {
    const posts: { url: string; headers: Record<string, string> }[] = [];
    const realtime = realtimeFromEnv(
      { REALTIME_HTTP_DOMAIN: 'h.example', REALTIME_WS_DOMAIN: 'w.example', AWS_REGION: 'us-east-1' },
      {
        credentials: async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' }),
        post: async (url, init) => {
          posts.push({ url, headers: init.headers });
          return { ok: true, status: 200, text: async () => '{"successful":[{}],"failed":[]}' };
        }
      }
    );
    await realtime.publish('/fantasy/global', { type: 'chat', leagueId: 'lg-1', message: {} });
    expect(posts[0]?.url).toBe('https://h.example/event');
    expect(posts[0]?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/appsync\//
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

  it('pushes chat messages to the league channel', async () => {
    const realtime = new InMemoryRealtime();
    const result = await relay(
      realtime,
      silentLogger,
      event('Chat Message Posted', { leagueId: 'lg-1', message: { id: 'm1', text: 'hi' } })
    );
    expect(result).toEqual({ channels: ['/fantasy/league/lg-1'] });
    expect(realtime.published[0]?.message).toEqual({
      type: 'chat',
      leagueId: 'lg-1',
      message: { id: 'm1', text: 'hi' }
    });
    expect(await relay(realtime, silentLogger, event('Chat Message Posted', { leagueId: 'lg-1' }))).toEqual({
      channels: []
    });
  });

  it('pushes DM messages only to the two teams’ channels, and drops a DM it cannot address', async () => {
    const realtime = new InMemoryRealtime();
    const dm = { id: 'm2', roomId: 'dm-team-1-team-2', text: 'secret' };
    expect(
      await relay(
        realtime,
        silentLogger,
        event('Chat Message Posted', {
          leagueId: 'lg-1',
          roomId: 'dm-team-1-team-2',
          teamIds: ['team-1', 'team-2'],
          message: dm
        })
      )
    ).toEqual({ channels: [tc('lg-1', 'team-1'), tc('lg-1', 'team-2')] });
    // No detail room but a DM message, or a DM without both teams: never the league channel.
    for (const detail of [
      { leagueId: 'lg-1', message: dm },
      { leagueId: 'lg-1', roomId: 'dm-team-1-team-2', teamIds: ['team-1', 'team-1'], message: dm },
      { leagueId: 'lg-1', roomId: 'dm-team-1-team-2', teamIds: null, message: dm }
    ]) {
      expect(await relay(realtime, silentLogger, event('Chat Message Posted', detail))).toEqual({
        channels: []
      });
    }
    expect(realtime.published.map((p) => p.channel)).toEqual([tc('lg-1', 'team-1'), tc('lg-1', 'team-2')]);
    expect(
      await relay(
        realtime,
        silentLogger,
        event('Chat Message Posted', {
          leagueId: 'lg-1',
          roomId: 'draft',
          teamIds: null,
          message: { id: 'm3' }
        })
      )
    ).toEqual({ channels: ['/fantasy/league/lg-1'] });
  });

  it('passes league events through untouched, per league or globally', async () => {
    const realtime = new InMemoryRealtime();
    await relay(realtime, silentLogger, event('Draft Pick Made', { leagueId: 'lg-1', pick: 3 }));
    await relay(realtime, silentLogger, event('Scores Updated', { week: 5, playerIds: ['p'] }));
    await relay(realtime, silentLogger, event('Waivers Processed', { leagueIds: ['a', 'b', 'a', 3] }));
    await relay(realtime, silentLogger, { ...event('Trade Vetoed', 'not an object'), time: undefined });
    await relay(realtime, silentLogger, event('NFL Games Updated', { season: 2026, week: 5, games: [] }));
    expect(realtime.published.map((p) => p.channel)).toEqual([
      '/fantasy/league/lg-1',
      '/fantasy/global',
      '/fantasy/league/a',
      '/fantasy/league/b',
      '/fantasy/global',
      '/fantasy/global'
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

  it('sends each team its own waiver awards on its private channel', async () => {
    const realtime = new InMemoryRealtime();
    const awarded = [
      { teamId: 'team-1', playerId: 'p1' },
      { teamId: 'team-2', playerId: 'p2' },
      { teamId: 'team-1', playerId: 'p3' },
      null,
      { playerId: 'p4' }
    ];
    const result = await relay(
      realtime,
      silentLogger,
      event('Waivers Processed', { leagueId: 'lg-1', week: 5, awarded })
    );
    expect(result.channels).toEqual(['/fantasy/league/lg-1', tc('lg-1', 'team-1'), tc('lg-1', 'team-2')]);
    expect(realtime.published[1]?.message).toMatchObject({
      leagueId: 'lg-1',
      detail: { teamId: 'team-1', week: 5, awarded: [awarded[0], awarded[2]] }
    });
    expect(
      (await relay(realtime, silentLogger, event('Waivers Processed', { leagueId: 'lg-1', awarded: 'x' })))
        .channels
    ).toEqual(['/fantasy/league/lg-1']);
  });

  it('keeps failed waiver claims off the league channel and sends each team its own (#165)', async () => {
    const realtime = new InMemoryRealtime();
    const lost = [
      { teamId: 'team-2', playerId: 'p9', reason: 'Outbid.' },
      { teamId: 'team-3', playerId: 'p8', reason: 'Roster full.' }
    ];
    const result = await relay(
      realtime,
      silentLogger,
      event('Waivers Processed', { leagueId: 'lg-1', awarded: [{ teamId: 'team-1', playerId: 'p1' }], lost })
    );
    expect(result.channels).toEqual([
      '/fantasy/league/lg-1',
      tc('lg-1', 'team-1'),
      tc('lg-1', 'team-2'),
      tc('lg-1', 'team-3')
    ]);
    expect(realtime.published[0]?.message).toMatchObject({ detail: { awarded: [{ teamId: 'team-1' }] } });
    expect(JSON.stringify(realtime.published[0]?.message)).not.toContain('p9');
    expect(realtime.published[1]?.message).toMatchObject({ detail: { teamId: 'team-1', lost: [] } });
    expect(realtime.published[2]?.message).toMatchObject({
      detail: { teamId: 'team-2', awarded: [], lost: [lost[0]] }
    });
  });

  it('sends a new notification to its team’s channel alone (#165)', async () => {
    const realtime = new InMemoryRealtime();
    const result = await relay(
      realtime,
      silentLogger,
      event('Notification Created', { leagueId: 'lg-1', teamId: 'team-2', notification: { id: 'n1' } })
    );
    expect(result.channels).toEqual([tc('lg-1', 'team-2')]);
    expect(
      (await relay(realtime, silentLogger, event('Notification Created', { leagueId: 'lg-1' }))).channels
    ).toEqual([]);
  });

  it('ignores other events and other sources', async () => {
    const realtime = new InMemoryRealtime();
    expect(await relay(realtime, silentLogger, event('League Created', { leagueId: 'x' }))).toEqual({
      channels: []
    });
    expect(await relay(realtime, silentLogger, event('Draft Pick Made', {}, 'other'))).toEqual({
      channels: []
    });
    expect(realtime.published).toEqual([]);
    expect(RELAYED_EVENTS).toContain('Chat Message Posted');
  });

  it('keeps pending trade offers off the league channel: only the two teams see them', async () => {
    const realtime = new InMemoryRealtime();
    for (const detailType of TEAM_ONLY_EVENTS) {
      const detail = { leagueId: 'lg-1', tradeId: 't1', fromTeamId: 'team-1', toTeamId: 'team-2' };
      expect(await relay(realtime, silentLogger, event(detailType, detail))).toEqual({
        channels: [tc('lg-1', 'team-1'), tc('lg-1', 'team-2')]
      });
    }
    expect(realtime.published.some((p) => p.channel.startsWith('/fantasy/league/'))).toBe(false);
    expect(realtime.published[0]?.message).toMatchObject({ detailType: 'Trade Proposed', leagueId: 'lg-1' });
    // Without a single league, or without team ids, an offer goes nowhere.
    expect(await relay(realtime, silentLogger, event('Trade Proposed', { fromTeamId: 'team-1' }))).toEqual({
      channels: []
    });
    expect(
      await relay(realtime, silentLogger, event('Trade Proposed', { leagueId: 'lg-1', toTeamId: '' }))
    ).toEqual({ channels: [] });
    expect(await relay(realtime, silentLogger, event('Trade Accepted', { leagueId: 'lg-1' }))).toEqual({
      channels: ['/fantasy/league/lg-1']
    });
  });

  it("publishes a team's messages to its current tenure's channel, so a former occupant hears nothing more", async () => {
    const realtime = new InMemoryRealtime();
    let holder: Team = team('lg-1', 'team-2', { ownerUserId: 'bob' });
    const live = { get: async () => holder };
    const notify = event('Notification Created', { leagueId: 'lg-1', teamId: 'team-2' });
    const before = (await relayEvent(realtime, silentLogger, notify, live)).channels;
    expect(before).toEqual([teamChannel('lg-1', 'team-2', seatTenureKey(holder))]);
    // Bob leaves: an agent takes the seat.
    holder = team('lg-1', 'team-2', { ownerUserId: null, occupiedSince: '2026-09-20T00:00:00.000Z' });
    const after = (await relayEvent(realtime, silentLogger, notify, live)).channels;
    expect(after).toEqual([teamChannel('lg-1', 'team-2', seatTenureKey(holder))]);
    expect(after).not.toEqual(before);
  });

  it('reads each team once per event, and skips a team that no longer exists', async () => {
    const realtime = new InMemoryRealtime();
    const reads: string[] = [];
    const some = {
      get: async (leagueId: string, teamId: string) => {
        reads.push(teamId);
        return teamId === 'team-9' ? null : team(leagueId, teamId);
      }
    };
    const lines: string[] = [];
    const { createLogger } = await import('../log.js');
    const result = await relayEvent(
      realtime,
      createLogger({ sink: (l) => lines.push(l) }),
      event('Waivers Processed', {
        leagueId: 'lg-1',
        awarded: [{ teamId: 'team-1' }, { teamId: 'team-9' }],
        lost: [{ teamId: 'team-1' }]
      }),
      some
    );
    expect(result.channels).toEqual(['/fantasy/league/lg-1', tc('lg-1', 'team-1')]);
    expect(reads).toEqual(['team-1', 'team-9']);
    expect(lines.join('\n')).toMatch(/skipped a team that does not exist/);
  });

  it('runs as a Lambda handler with realtime off when nothing is configured', async () => {
    const deps = createRelayDeps({ LOG_LEVEL: 'error' });
    expect(deps.realtime).toBeInstanceOf(InMemoryRealtime);
    // No table: no team channels to look up.
    expect(await deps.teams.get('lg-1', 'team-1')).toBeNull();
    expect(createRelayDeps({ LOG_LEVEL: 'error', TABLE_NAME: 'fantasy' }).teams).toBeInstanceOf(
      DynamoTeamRepository
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await handler(event('Draft Pick Made', { leagueId: 'lg-1' }))).toEqual({
        channels: ['/fantasy/league/lg-1']
      });
    } finally {
      stdout.mockRestore();
    }
  });
});
