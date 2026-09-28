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
    expect(decodeCursor(encodeCursor(key))).toBe(key);
    expect(decodeCursor(encodeCursor('LEAGUE#x'))).toBeNull();
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
    const first = await repos.chat.list('lg-1', { limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual(['m4', 'm3']);
    const rest = await repos.chat.list('lg-1', { limit: 5, cursor: first.nextCursor ?? '' });
    expect(rest).toEqual({
      messages: [expect.objectContaining({ id: 'm2' }), expect.anything(), expect.anything()],
      nextCursor: null
    });
    expect(await repos.chat.list('other', { limit: 5 })).toEqual({ messages: [], nextCursor: null });
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
    [1, 2].map((slot) =>
      newTeam({ leagueId: 'lg-1', id: `team-${slot}`, draftSlot: slot, settings, now: new Date(START) })
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
    const { services, events } = await setup();
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
    expect(events.events[1]?.detail).toEqual({
      leagueId: 'lg-1',
      moment: 'Trade complete between Team 1 and Team 2.',
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
      expect(await handler(bus('League Created', {}))).toEqual({ status: 'skipped', reason: 'no_template' });
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
