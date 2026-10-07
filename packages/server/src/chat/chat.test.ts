import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FixedClock, yahooDefaultSettings } from '@fantasy/core';
import { DynamoChatRepository } from '../repos/dynamo/chat.js';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventPublisher } from '../events/publisher.js';
import { eventLeagueIds } from '../events/bus.js';
import { newTeam } from '../league/seats.js';
import { silentLogger } from '../log.js';
import { createInMemoryRepos } from '../repos/memory.js';
import type { League } from '../repos/types.js';
import { createChatEventServices, handler } from './lambda.js';
import { authorKey, decodeCursor, encodeCursor, messageSortKey, type ChatMessage } from './model.js';
import { postSystemMessage, SYSTEM_MESSAGE_EVENTS } from './system-messages.js';

const START = '2026-10-04T15:00:00.000Z';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    leagueId: 'lg-1',
    roomId: 'trash-talk',
    kind: 'user',
    author: { teamId: 'team-1', teamName: 'A', name: 'Alice' },
    text: 'hi',
    mentionedTeamIds: [],
    event: null,
    createdAt: START,
    ...overrides
  };
}

describe('chat model', () => {
  it('round-trips cursors and rejects foreign ones', () => {
    const key = messageSortKey(message());
    expect(key).toBe(`MSG#${START}#m1`);
    expect(decodeCursor(encodeCursor(key), 'trash-talk')).toBe(key);
    expect(decodeCursor(encodeCursor(key), 'draft')).toBeNull();
    expect(decodeCursor(encodeCursor('LEAGUE#x'), 'trash-talk')).toBeNull();
    const draftKey = messageSortKey(message({ roomId: 'draft' }));
    expect(draftKey).toBe(`ROOM#draft#MSG#${START}#m1`);
    expect(decodeCursor(encodeCursor(draftKey), 'draft')).toBe(draftKey);
    expect(decodeCursor(encodeCursor(draftKey), 'trash-talk')).toBeNull();
    expect(decodeCursor(encodeCursor('ROOM#draft#MSG#nohash'), 'draft')).toBeNull();
    expect(authorKey(message())).toBe('user#team-1');
    expect(
      authorKey(message({ kind: 'system', author: { teamId: null, teamName: null, name: 'League' } }))
    ).toBe('system#league');
  });

  it('pages the in-memory repository like DynamoDB', async () => {
    const repos = createInMemoryRepos();
    for (let i = 0; i < 5; i++) {
      expect(await repos.chat.put(message({ id: `m${i}`, createdAt: `2026-10-04T15:00:0${i}.000Z` }))).toBe(
        true
      );
    }
    expect(await repos.chat.put(message({ id: 'm0', createdAt: '2026-10-04T15:00:00.000Z' }))).toBe(false);
    const first = await repos.chat.list('lg-1', 'trash-talk', { limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual(['m4', 'm3']);
    const rest = await repos.chat.list('lg-1', 'trash-talk', { limit: 5, cursor: first.nextCursor ?? '' });
    expect(rest).toEqual({
      messages: [expect.objectContaining({ id: 'm2' }), expect.anything(), expect.anything()],
      nextCursor: null
    });
    expect(await repos.chat.list('other', 'trash-talk', { limit: 5 })).toEqual({
      messages: [],
      nextCursor: null
    });
    expect(await repos.chat.list('lg-1', 'draft', { limit: 5 })).toEqual({ messages: [], nextCursor: null });
    expect(await repos.chat.summary('other', 'draft', null)).toEqual({ lastMessageAt: null, unreadCount: 0 });
    expect(await repos.chat.activity('other', START)).toEqual([]);
    expect(await repos.chat.dmRooms('other', 'team-1')).toEqual([]);
    expect(await repos.chat.readState('other', 'user#u1')).toEqual({});
  });
});

describe('DynamoChatRepository', () => {
  it('rethrows errors other than a duplicate key', async () => {
    const boom = new Error('throttled');
    const repo = new DynamoChatRepository({
      tableName: 'T',
      doc: { send: async () => Promise.reject(boom) } as unknown as DynamoDBDocumentClient
    });
    await expect(repo.put(message())).rejects.toBe(boom);
  });
});

describe('eventLeagueIds', () => {
  it('reads leagueId or leagueIds', () => {
    expect(eventLeagueIds({ leagueId: 'a' })).toEqual(['a']);
    expect(eventLeagueIds({ leagueId: '', leagueIds: ['b', 'b', ''] })).toEqual(['b']);
    expect(eventLeagueIds({})).toEqual([]);
  });
});

async function setup() {
  const repos = createInMemoryRepos();
  const settings = yahooDefaultSettings(4);
  const league: League = {
    id: 'lg-1',
    name: 'L',
    season: 2026,
    phase: 'regular_season',
    week: 5,
    settings,
    commissionerId: 'u1',
    commissionerName: 'Alice',
    createdBy: 'u1',
    scheduleSeed: 's',
    deadlines: { draftStartsAt: null, nextLineupLockAt: null, nextWaiverRunAt: null, tradeDeadlineAt: null },
    createdAt: START,
    updatedAt: START,
    version: 1
  };
  await repos.leagues.create(league);
  await repos.teams.create(
    // team-1: Alice's; team-2: an agent seat.
    [1, 2].map((slot) =>
      newTeam({
        leagueId: 'lg-1',
        id: `team-${slot}`,
        draftSlot: slot,
        settings,
        now: new Date(START),
        ...(slot === 1 ? { owner: { userId: 'u1', name: 'Alice', teamName: 'Team 1' } } : {})
      })
    )
  );
  const events = new InMemoryEventPublisher();
  const services = { repos, events, clock: new FixedClock(START), log: silentLogger };
  return { repos, events, services };
}

const bus = (detailType: string, detail: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'evt-9',
  source: 'fantasy',
  'detail-type': detailType,
  detail,
  ...extra
});

describe('postSystemMessage', () => {
  it('announces big moments to agents as Chat Moment', async () => {
    const { services, events, repos } = await setup();
    await repos.agents.putSeat({
      leagueId: 'lg-1',
      teamId: 'team-2',
      agentId: 'lg-1.team-2',
      config: { personalityId: 'hype-man', difficulty: 'pro', archetype: 'balanced', name: 'Ruth Carter' },
      version: 1,
      updatedAt: START,
      updatedBy: 'user#u1'
    });
    const outcome = await postSystemMessage(
      services,
      bus(
        'Trade Processed',
        { leagueId: 'lg-1', fromTeamId: 'team-1', toTeamId: 'team-2' },
        { time: 'not a time' }
      )
    );
    expect(outcome).toMatchObject({
      status: 'posted',
      moment: true,
      message: { createdAt: START, kind: 'system' }
    });
    expect(events.events.map((e) => e.detailType)).toEqual(['Chat Message Posted', 'Chat Moment']);
    expect(outcome).toMatchObject({ message: { roomId: 'trades' }, matchupMessages: [] });
    expect(events.events[1]?.detail).toEqual({
      leagueId: 'lg-1',
      roomId: 'trades',
      // The agent team carries its AI manager's name; Alice's team does not (#151).
      moment: 'Trade complete between Team 1 and Team 2 (Ruth Carter).',
      messageId: 'sys-evt-9',
      sourceEventType: 'Trade Processed',
      sourceEventId: 'evt-9',
      teamId: 'team-1'
    });
  });

  it('posts ordinary messages without a moment, and moments without a subject team', async () => {
    const { services, events } = await setup();
    await postSystemMessage(
      services,
      bus('Draft Pick Made', { leagueId: 'lg-1', teamId: 'team-2', player: 'X' })
    );
    expect(events.events.map((e) => e.detailType)).toEqual(['Chat Message Posted']);
    await postSystemMessage(services, { ...bus('Draft Completed', { leagueId: 'lg-1' }), id: 'evt-10' });
    expect(events.events[2]?.detail).not.toHaveProperty('teamId');
  });

  it('posts a week final to the league room and one line to each matchup room', async () => {
    const { services, events, repos } = await setup();
    const line = (matchupId: string, homeScore: number, awayScore: number) => ({
      matchupId,
      homeTeamId: 'team-1',
      awayTeamId: 'team-2',
      homeScore,
      awayScore,
      status: 'final'
    });
    const detail = {
      leagueId: 'lg-1',
      week: 5,
      topTeamId: 'team-1',
      topScore: 120,
      blowout: null,
      matchups: [
        line('W05-1', 120, 118.5),
        line('W05-2', 90, 89),
        line('W05-3', 100, 50),
        null,
        { matchupId: 'x' }
      ]
    };
    const outcome = await postSystemMessage(services, bus('Week Provisionally Final', detail));
    if (outcome.status !== 'posted') throw new Error('expected a message');
    expect(outcome.message).toMatchObject({ id: 'sys-evt-9', roomId: 'league' });
    expect(outcome.matchupMessages.map((m) => [m.id, m.roomId, m.text])).toEqual([
      ['sys-evt-9-W05-1', 'm-2026-W05-W05-1', 'Final (provisional): Team 1 120, Team 2 118.5.'],
      ['sys-evt-9-W05-2', 'm-2026-W05-W05-2', 'Final (provisional): Team 1 90, Team 2 89.'],
      ['sys-evt-9-W05-3', 'm-2026-W05-W05-3', 'Final (provisional): Team 1 100, Team 2 50.']
    ]);
    // The league moment, then one moment for the closest game only, in its room.
    const moments = events.events.filter((e) => e.detailType === 'Chat Moment').map((e) => e.detail);
    expect(moments).toEqual([
      expect.objectContaining({ roomId: 'league', messageId: 'sys-evt-9' }),
      expect.objectContaining({
        roomId: 'm-2026-W05-W05-2',
        messageId: 'sys-evt-9-W05-2',
        teamIds: ['team-1', 'team-2'],
        moment: 'Final (provisional): Team 1 90, Team 2 89.'
      })
    ]);
    expect((await repos.chat.list('lg-1', 'm-2026-W05-W05-2', { limit: 5 })).messages).toHaveLength(1);

    // Redelivered: nothing new anywhere.
    const count = events.events.length;
    expect(await postSystemMessage(services, bus('Week Provisionally Final', detail))).toEqual({
      status: 'duplicate',
      messageId: 'sys-evt-9'
    });
    expect(events.events).toHaveLength(count);

    // Official: no moments in matchup rooms.
    await postSystemMessage(services, {
      ...bus('Week Official Final', { ...detail, recap: 'No stat corrections changed a score.' }),
      id: 'evt-11'
    });
    expect(events.events.slice(count).map((e) => e.detailType)).toEqual(Array(4).fill('Chat Message Posted'));
    // A matchup room already holding its line (a retried run) is skipped quietly.
    await repos.chat.put(message({ id: 'sys-evt-12-W05-1', roomId: 'm-2026-W05-W05-1', createdAt: START }));
    const retried = await postSystemMessage(services, {
      ...bus('Week Official Final', { ...detail, recap: 'r' }, { time: START }),
      id: 'evt-12'
    });
    expect(retried.status === 'posted' && retried.matchupMessages.map((m) => m.id)).toEqual([
      'sys-evt-12-W05-2',
      'sys-evt-12-W05-3'
    ]);
  });

  it('skips what it cannot or should not announce', async () => {
    const { services, events } = await setup();
    expect(await postSystemMessage(services, bus('Draft Pick Made', {}, { source: 'other' }))).toEqual({
      status: 'skipped',
      reason: 'not_ours'
    });
    expect(await postSystemMessage(services, bus('League Created', { leagueId: 'lg-1' }))).toEqual({
      status: 'skipped',
      reason: 'no_template'
    });
    expect(await postSystemMessage(services, bus('Draft Completed', { leagueId: 'nope' }))).toEqual({
      status: 'skipped',
      reason: 'no_league'
    });
    expect(await postSystemMessage(services, bus('Draft Completed', null))).toEqual({
      status: 'skipped',
      reason: 'no_league'
    });
    expect(
      await postSystemMessage(services, bus('Draft Pick Made', { leagueId: 'lg-1', teamId: 'team-9' }))
    ).toEqual({
      status: 'skipped',
      reason: 'nothing_to_say'
    });
    expect(events.events).toEqual([]);
    expect(SYSTEM_MESSAGE_EVENTS).toContain('Waivers Processed');
  });
});

describe('chat events Lambda', () => {
  it('needs the table name', () => {
    expect(() => createChatEventServices({})).toThrow(/TABLE_NAME/);
    expect(createChatEventServices({ TABLE_NAME: 'T' }).repos.chat).toBeDefined();
  });

  it('handles events with services from the environment', async () => {
    vi.stubEnv('TABLE_NAME', 'T');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await handler(bus('League Created', {}))).toEqual({
        chat: { status: 'skipped', reason: 'no_template' },
        notifications: { status: 'skipped', reason: 'not_notifiable' }
      });
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
