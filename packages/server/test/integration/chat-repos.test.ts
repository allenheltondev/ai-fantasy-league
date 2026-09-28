import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/chat/model.js';
import { startLocalTable, type LocalTable } from '../../src/dev/dynalite.js';
import { createDynamoRepos } from '../../src/repos/dynamo/index.js';
import { createInMemoryRepos } from '../../src/repos/memory.js';
import type { Repos } from '../../src/repos/types.js';

let table: LocalTable;
beforeAll(async () => {
  table = await startLocalTable();
});
afterAll(() => table.close());

/** The chat repository's contract (rooms, #144), run against both implementations. */
const backends: [string, () => Repos][] = [
  ['in-memory', () => createInMemoryRepos()],
  ['DynamoDB (dynalite)', () => createDynamoRepos(table)]
];

let counter = 0;
const unique = () => `lg-chatrepo-${++counter}`;
const at = (second: number) => `2026-10-04T15:00:${String(second).padStart(2, '0')}.000Z`;

function message(leagueId: string, overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm',
    leagueId,
    roomId: 'trash-talk',
    kind: 'user',
    author: { teamId: 'team-1', teamName: 'A', name: 'Alice' },
    text: 'hi',
    mentionedTeamIds: [],
    event: null,
    createdAt: at(0),
    ...overrides
  };
}

for (const [name, make] of backends) {
  describe(`chat rooms repository (${name})`, () => {
    it('keeps each room apart, newest first, with cursors bound to their room', async () => {
      const repos = make();
      const lg = unique();
      for (let i = 1; i <= 3; i++) {
        await repos.chat.put(message(lg, { id: `t${i}`, createdAt: at(i) }));
        await repos.chat.put(message(lg, { id: `d${i}`, roomId: 'draft', createdAt: at(i) }));
      }
      await repos.chat.put(message(lg, { id: 'm1', roomId: 'm-2026-W05-W05-1', createdAt: at(9) }));
      expect(await repos.chat.put(message(lg, { id: 'd1', roomId: 'draft', createdAt: at(1) }))).toBe(false);

      const first = await repos.chat.list(lg, 'draft', { limit: 2 });
      expect(first.messages.map((m) => m.id)).toEqual(['d3', 'd2']);
      expect(first.messages.every((m) => m.roomId === 'draft')).toBe(true);
      const rest = await repos.chat.list(lg, 'draft', { limit: 2, cursor: first.nextCursor ?? '' });
      expect(rest.messages.map((m) => m.id)).toEqual(['d1']);
      expect(rest.nextCursor).toBeNull();
      // A draft cursor means nothing in trash talk: it starts from the newest.
      const trash = await repos.chat.list(lg, 'trash-talk', { limit: 5, cursor: first.nextCursor ?? '' });
      expect(trash.messages.map((m) => m.id)).toEqual(['t3', 't2', 't1']);
      expect((await repos.chat.list(lg, 'm-2026-W05-W05-1', { limit: 5 })).messages.map((m) => m.id)).toEqual(
        ['m1']
      );
    });

    it('counts unread messages after a read marker that only moves forward', async () => {
      const repos = make();
      const lg = unique();
      expect(await repos.chat.summary(lg, 'draft', null)).toEqual({ lastMessageAt: null, unreadCount: 0 });
      for (let i = 1; i <= 4; i++)
        await repos.chat.put(message(lg, { id: `d${i}`, roomId: 'draft', createdAt: at(i) }));
      expect(await repos.chat.summary(lg, 'draft', null)).toEqual({ lastMessageAt: at(4), unreadCount: 4 });
      expect(await repos.chat.summary(lg, 'draft', at(2))).toEqual({ lastMessageAt: at(4), unreadCount: 2 });
      expect(await repos.chat.summary(lg, 'draft', at(4))).toEqual({ lastMessageAt: at(4), unreadCount: 0 });
      expect(await repos.chat.summary(lg, 'trash-talk', null)).toEqual({
        lastMessageAt: null,
        unreadCount: 0
      });

      await repos.chat.markRead(lg, 'user#alice', 'draft', at(3));
      await repos.chat.markRead(lg, 'user#alice', 'draft', at(1));
      await repos.chat.markRead(lg, 'user#alice', 'trades', at(5));
      await repos.chat.markRead(lg, 'user#alicia', 'draft', at(9));
      expect(await repos.chat.readState(lg, 'user#alice')).toEqual({ draft: at(3), trades: at(5) });
    });

    it('hides messages from before a reader may see them (a DM seat’s new occupant)', async () => {
      const repos = make();
      const lg = unique();
      const dm = 'dm-team-1-team-2';
      for (let i = 1; i <= 4; i++)
        await repos.chat.put(message(lg, { id: `d${i}`, roomId: dm, createdAt: at(i) }));
      expect(await repos.chat.summary(lg, dm, null, at(3))).toEqual({ lastMessageAt: at(4), unreadCount: 2 });
      expect(await repos.chat.summary(lg, dm, at(3), at(2))).toEqual({
        lastMessageAt: at(4),
        unreadCount: 1
      });
      expect(await repos.chat.summary(lg, dm, at(1), at(3))).toEqual({
        lastMessageAt: at(4),
        unreadCount: 2
      });
      expect(await repos.chat.summary(lg, dm, at(4), at(2))).toEqual({
        lastMessageAt: at(4),
        unreadCount: 0
      });
      expect(await repos.chat.summary(lg, dm, null, at(5))).toEqual({ lastMessageAt: null, unreadCount: 0 });
      expect(await repos.chat.summary(lg, dm, at(9), at(5))).toEqual({ lastMessageAt: null, unreadCount: 0 });
    });

    it('caps unread counts at 100', async () => {
      const repos = make();
      const lg = unique();
      const base = Date.parse(at(0));
      for (let i = 0; i < 105; i++) {
        await repos.chat.put(
          message(lg, { id: `x${i}`, roomId: 'league', createdAt: new Date(base + i * 1000).toISOString() })
        );
      }
      expect((await repos.chat.summary(lg, 'league', null)).unreadCount).toBe(100);
    });

    it('indexes activity across rooms (no text) and each team’s DMs', async () => {
      const repos = make();
      const lg = unique();
      await repos.chat.put(message(lg, { id: 'a', createdAt: at(1) }));
      await repos.chat.put(
        message(lg, {
          id: 'b',
          roomId: 'dm-team-1-team-2',
          kind: 'agent',
          author: { teamId: 'team-2', teamName: 'B', name: 'B' },
          createdAt: at(2)
        }),
        { dmTeamIds: ['team-1', 'team-2'] }
      );
      await repos.chat.put(message(lg, { id: 'c', roomId: 'dm-team-1-team-3', createdAt: at(3) }), {
        dmTeamIds: ['team-1', 'team-3']
      });
      // A duplicate adds nothing.
      expect(await repos.chat.put(message(lg, { id: 'a', createdAt: at(1) }))).toBe(false);
      expect(await repos.chat.activity(lg, at(1))).toEqual([
        {
          messageId: 'c',
          roomId: 'dm-team-1-team-3',
          kind: 'user',
          teamId: 'team-1',
          createdAt: at(3),
          replyToAgentDepth: 0
        },
        {
          messageId: 'b',
          roomId: 'dm-team-1-team-2',
          kind: 'agent',
          teamId: 'team-2',
          createdAt: at(2),
          replyToAgentDepth: 0
        }
      ]);
      expect(await repos.chat.activity(lg, at(0))).toHaveLength(3);
      expect(await repos.chat.dmRooms(lg, 'team-1')).toEqual(['dm-team-1-team-2', 'dm-team-1-team-3']);
      expect(await repos.chat.dmRooms(lg, 'team-3')).toEqual(['dm-team-1-team-3']);
      expect(await repos.chat.dmRooms(lg, 'team-4')).toEqual([]);
    });

    it('keeps a retort’s reply fields, and indexes its depth for the banter budget', async () => {
      const repos = make();
      const lg = unique();
      const retort = message(lg, {
        id: 'r',
        kind: 'agent',
        author: { teamId: 'team-3', teamName: 'C', name: 'C' },
        replyToId: 'a',
        replyToAgentDepth: 1,
        createdAt: at(2)
      });
      await repos.chat.put(retort);
      expect((await repos.chat.list(lg, retort.roomId, { limit: 5 })).messages[0]).toMatchObject({
        replyToId: 'a',
        replyToAgentDepth: 1
      });
      expect(await repos.chat.activity(lg, at(0))).toEqual([
        expect.objectContaining({ messageId: 'r', replyToAgentDepth: 1 })
      ]);
    });
  });
}

describe('chat rooms repository (DynamoDB, before rooms)', () => {
  it('reads a message stored before rooms existed as trash talk', async () => {
    const repos = createDynamoRepos(table);
    const lg = unique();
    const legacy = message(lg, { id: 'old', createdAt: at(1) }) as Partial<ChatMessage>;
    delete legacy.roomId;
    await table.doc.send(
      new PutCommand({
        TableName: table.tableName,
        Item: { pk: `CHAT#${lg}`, sk: `MSG#${at(1)}#old`, entity: 'chat', ...legacy }
      })
    );
    const page = await repos.chat.list(lg, 'trash-talk', { limit: 5 });
    expect(page.messages).toEqual([expect.objectContaining({ id: 'old', roomId: 'trash-talk' })]);
  });
});
